import path from 'path'
import webpack from 'webpack'
import resolve from 'next/dist/compiled/resolve/index.js'
import NextJsSsrImportPlugin from './webpack/plugins/nextjs-ssr-import'
import NextJsSSRModuleCachePlugin from './webpack/plugins/nextjs-ssr-module-cache'
import PagesManifestPlugin from './webpack/plugins/pages-manifest-plugin'
import BuildManifestPlugin from './webpack/plugins/build-manifest-plugin'
import ChunkNamesPlugin from './webpack/plugins/chunk-names-plugin'
import { ReactLoadablePlugin } from './webpack/plugins/react-loadable-plugin'
import { SERVER_DIRECTORY, REACT_LOADABLE_MANIFEST, CLIENT_STATIC_FILES_RUNTIME_WEBPACK, CLIENT_STATIC_FILES_RUNTIME_MAIN } from 'next-server/constants'
import { NEXT_PROJECT_ROOT, NEXT_PROJECT_ROOT_DIST_CLIENT, PAGES_DIR_ALIAS, DOT_NEXT_ALIAS } from '../lib/constants'
import {TerserPlugin} from './webpack/plugins/terser-webpack-plugin/src/index'
import { ServerlessPlugin } from './webpack/plugins/serverless-plugin'
import { AllModulesIdentifiedPlugin } from './webpack/plugins/all-modules-identified-plugin'
import { SharedRuntimePlugin } from './webpack/plugins/shared-runtime-plugin'
import { HashedChunkIdsPlugin } from './webpack/plugins/hashed-chunk-ids-plugin'
import { ChunkGraphPlugin } from './webpack/plugins/chunk-graph-plugin'
import { DropClientPage } from './webpack/plugins/next-drop-client-page-plugin'
import { importAutoDllPlugin } from './webpack/plugins/dll-import'
import { WebpackEntrypoints } from './entries'
type ExcludesFalse = <T>(x: T | false) => x is T

export default async function getBaseWebpackConfig (dir: string, {dev = false, debug = false, isServer = false, buildId, config, target = 'server', entrypoints, selectivePageBuilding = false}: {dev?: boolean, debug?: boolean, isServer?: boolean, buildId: string, config: any, target?: string, entrypoints: WebpackEntrypoints, selectivePageBuilding?: boolean}): Promise<webpack.Configuration> {
  const distDir = path.join(dir, config.distDir)
  const defaultLoaders = {
    babel: {
      loader: 'next-babel-loader',
      options: { isServer, distDir, cwd: dir, asyncToPromises: config.experimental.asyncToPromises }
    },
    // Backwards compat
    hotSelfAccept: {
      loader: 'noop-loader'
    }
  }

  // Support for NODE_PATH
  const nodePathList = (process.env.NODE_PATH || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter((p) => !!p)

  const outputDir = target === 'serverless' ? 'serverless' : SERVER_DIRECTORY
  const outputPath = path.join(distDir, isServer ? outputDir : '')
  const totalPages = Object.keys(entrypoints).length
  const clientEntries = !isServer ? {
    // Backwards compatibility
    'main.js': [],
    [CLIENT_STATIC_FILES_RUNTIME_MAIN]: `.${path.sep}` + path.relative(dir, path.join(NEXT_PROJECT_ROOT_DIST_CLIENT, (dev ? `next-dev.js` : 'next.js')))
  } : undefined

  const resolveConfig = {
    // Disable .mjs for node_modules bundling
    extensions: isServer ? ['.tsx', '.ts', '.js', '.mjs', '.jsx', '.json', '.wasm'] : ['.tsx', '.ts', '.mjs', '.js', '.jsx', '.json', '.wasm'],
    modules: [
      'node_modules',
      ...nodePathList // Support for NODE_PATH environment variable
    ],
    alias: {
      // These aliases make sure the wrapper module is not included in the bundles
      // Which makes bundles slightly smaller, but also skips parsing a module that we know will result in this alias
      'next/head': 'next-server/dist/lib/head.js',
      'next/router': 'next/dist/client/router.js',
      'next/config': 'next-server/dist/lib/runtime-config.js',
      'next/dynamic': 'next-server/dist/lib/dynamic.js',
      next: NEXT_PROJECT_ROOT,
      [PAGES_DIR_ALIAS]: path.join(dir, 'pages'),
      [DOT_NEXT_ALIAS]: distDir,
    },
    mainFields: isServer ? ['main', 'module'] : ['browser', 'module', 'main']
  }

  const webpackMode = dev ? 'development' : 'production'

  const terserPluginConfig = {
    parallel: true,
    sourceMap: false,
    cache: true,
    cpus: config.experimental.cpus,
    distDir: distDir
  }

  let webpackConfig: webpack.Configuration = {
    mode: webpackMode,
    devtool: (dev || debug) ? 'cheap-module-source-map' : false,
    name: isServer ? 'server' : 'client',
    target: isServer ? 'node' : 'web',
    externals: !isServer ? undefined : target !== 'serverless' ? [
      (context, request, callback) => {
        const notExternalModules = [
          'next/app', 'next/document', 'next/link', 'next/error',
          'string-hash',
          'next/constants'
        ]

        if (notExternalModules.indexOf(request) !== -1) {
          return callback()
        }

        resolve(request, { basedir: dir, preserveSymlinks: true }, (err, res) => {
          if (err) {
            return callback()
          }

          if (!res) {
            return callback()
          }

          // Default pages have to be transpiled
          if (res.match(/next[/\\]dist[/\\]/) || res.match(/node_modules[/\\]@babel[/\\]runtime[/\\]/) || res.match(/node_modules[/\\]@babel[/\\]runtime-corejs2[/\\]/)) {
            return callback()
          }

          // Webpack itself has to be compiled because it doesn't always use module relative paths
          if (res.match(/node_modules[/\\]webpack/) || res.match(/node_modules[/\\]css-loader/)) {
            return callback()
          }

          // styled-jsx has to be transpiled
          if (res.match(/node_modules[/\\]styled-jsx/)) {
            return callback()
          }

          if (res.match(/node_modules[/\\].*\.js$/)) {
            return callback(undefined, `commonjs ${request}`)
          }

          callback()
        })
      }
    ] : [
      // When the serverless target is used all node_modules will be compiled into the output bundles
      // So that the serverless bundles have 0 runtime dependencies
      'amp-toolbox-optimizer' // except this one
    ],
    optimization: Object.assign({
      checkWasmTypes: false,
      nodeEnv: false,
    }, isServer ? {
      splitChunks: false,
      minimize: false
    } : {
      runtimeChunk: selectivePageBuilding ? false : {
        name: CLIENT_STATIC_FILES_RUNTIME_WEBPACK
      },
      splitChunks: dev ? {
        cacheGroups: {
          default: false,
          vendors: false
        }
      } : selectivePageBuilding ? {
        cacheGroups: {
          default: false,
          vendors: false,
          react: {
            name: 'commons',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/
          }
        }
      } : {
        chunks: 'all',
        cacheGroups: {
          default: false,
          vendors: false,
          commons: {
            name: 'commons',
            chunks: 'all',
            minChunks: totalPages > 2 ? totalPages * 0.5 : 2
          },
          react: {
            name: 'commons',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/
          }
        }
      },
      minimize: !(dev || debug),
      minimizer: !(dev || debug) ? [
        new TerserPlugin({...terserPluginConfig,
          terserOptions: {
            safari10: true,
            ...((selectivePageBuilding || config.experimental.terserLoader) ? { compress: false, mangle: true } : undefined)
          }
        })
      ] : undefined,
    }, selectivePageBuilding ? {
      providedExports: false,
      usedExports: false,
      concatenateModules: false,
    } : undefined),
    recordsPath: selectivePageBuilding ? undefined : path.join(outputPath, 'records.json'),
    context: dir,
    // Kept as function to be backwards compatible
    entry: async () => {
      return {
        ...clientEntries ? clientEntries : {},
        ...entrypoints
      }
    },
    output: {
      path: outputPath,
      filename: ({chunk}: {chunk: {name: string}}) => {
        // Use `[name]-[contenthash].js` in production
        if (!dev && (chunk.name === CLIENT_STATIC_FILES_RUNTIME_MAIN || chunk.name === CLIENT_STATIC_FILES_RUNTIME_WEBPACK)) {
          return chunk.name.replace(/\.js$/, '-[contenthash].js')
        }
        return '[name]'
      },
      libraryTarget: isServer ? 'commonjs2' : 'var',
      hotUpdateChunkFilename: 'static/webpack/[id].[hash].hot-update.js',
      hotUpdateMainFilename: 'static/webpack/[hash].hot-update.json',
      // This saves chunks with the name given via `import()`
      chunkFilename: isServer ? `${dev ? '[name]' : '[name].[contenthash]'}.js` : `static/chunks/${dev ? '[name]' : '[name].[contenthash]'}.js`,
      strictModuleExceptionHandling: true,
      crossOriginLoading: config.crossOrigin,
      futureEmitAssets: !dev,
      webassemblyModuleFilename: 'static/wasm/[modulehash].wasm'
    },
    performance: false,
    resolve: resolveConfig,
    resolveLoader: {
      modules: [
        path.join(__dirname, 'webpack', 'loaders'), // The loaders Next.js provides
        'node_modules',
        ...nodePathList // Support for NODE_PATH environment variable
      ]
    },
    // @ts-ignore this is filtered
    module: {
      rules: [
        (selectivePageBuilding || config.experimental.terserLoader) && !isServer && !debug && {
          test: /\.(js|mjs|jsx)$/,
          exclude: /\.min\.(js|mjs|jsx)$/,
          use: {
            loader: 'next-minify-loader',
            options: { terserOptions: { safari10: true, compress: true, mangle: false } }
          }
        },
        config.experimental.ampBindInitData && !isServer && {
          test: /\.(tsx|ts|js|mjs|jsx)$/,
          include: [path.join(dir, 'data')],
          use: 'next-data-loader'
        },
        {
          test: /\.(tsx|ts|js|mjs|jsx)$/,
          include: [dir, /next-server[\\/]dist[\\/]lib/],
          exclude: (path: string) => {
            if (/next-server[\\/]dist[\\/]lib/.test(path)) {
              return false
            }

            return /node_modules/.test(path)
          },
          use: defaultLoaders.babel
        },
      ].filter(Boolean)
    },
    plugins: [
      // This plugin makes sure `output.filename` is used for entry chunks
      new ChunkNamesPlugin(),
      new webpack.DefinePlugin({
        ...(Object.keys(config.env).reduce((acc, key) => {
          if (/^(?:NODE_.+)|(?:__.+)$/i.test(key)) {
            throw new Error(`The key "${key}" under "env" in next.config.js is not allowed. https://err.sh/zeit/next.js/env-key-not-allowed`)
          }

          return {
            ...acc,
            [`process.env.${key}`]: JSON.stringify(config.env[key])
          }
        }, {})),
        'process.env.NODE_ENV': JSON.stringify(webpackMode),
        'process.crossOrigin': JSON.stringify(config.crossOrigin),
        'process.browser': JSON.stringify(!isServer),
        // This is used in client/dev-error-overlay/hot-dev-client.js to replace the dist directory
        ...(dev && !isServer ? {
          'process.env.__NEXT_DIST_DIR': JSON.stringify(distDir)
        } : {}),
        'process.env.__NEXT_EXPERIMENTAL_DEBUG': JSON.stringify(debug),
        'process.env.__NEXT_EXPORT_TRAILING_SLASH': JSON.stringify(config.experimental.exportTrailingSlash)
      }),
      !isServer && new ReactLoadablePlugin({
        filename: REACT_LOADABLE_MANIFEST
      }),
      selectivePageBuilding && new ChunkGraphPlugin(buildId, {
        dir, distDir, isServer
      }),
      !isServer && new DropClientPage(),
      ...(dev ? (() => {
        // Even though require.cache is server only we have to clear assets from both compilations
        // This is because the client compilation generates the build manifest that's used on the server side
        const {NextJsRequireCacheHotReloader} = require('./webpack/plugins/nextjs-require-cache-hot-reloader')
        const {UnlinkRemovedPagesPlugin} = require('./webpack/plugins/unlink-removed-pages-plugin')
        const devPlugins = [
          new UnlinkRemovedPagesPlugin(),
          new webpack.NoEmitOnErrorsPlugin(),
          new NextJsRequireCacheHotReloader(),
        ]

        if (!isServer) {
          const AutoDllPlugin = importAutoDllPlugin({ distDir })
          devPlugins.push(
            new AutoDllPlugin({
              filename: '[name]_[hash].js',
              path: './static/development/dll',
              context: dir,
              entry: {
                dll: [
                  'react',
                  'react-dom'
                ]
              },
              config: {
                mode: webpackMode,
                resolve: resolveConfig
              }
            })
          )
          devPlugins.push(new webpack.HotModuleReplacementPlugin())
        }

        return devPlugins
      })() : []),
      !dev && new webpack.HashedModuleIdsPlugin(),
      // This must come after HashedModuleIdsPlugin (it sets any modules that
      // were missed by HashedModuleIdsPlugin)
      !dev && selectivePageBuilding && new AllModulesIdentifiedPlugin(dir),
      // This sets chunk ids to be hashed versions of their names to reduce
      // bundle churn
      !dev && selectivePageBuilding && new HashedChunkIdsPlugin(buildId),
      // On the client we want to share the same runtime cache
      !isServer && selectivePageBuilding && new SharedRuntimePlugin(),
      !dev && new webpack.IgnorePlugin({
        checkResource: (resource: string) => {
          return /react-is/.test(resource)
        },
        checkContext: (context: string) => {
          return /next-server[\\/]dist[\\/]/.test(context) || /next[\\/]dist[\\/]/.test(context)
        }
      }),
      target === 'serverless' && (isServer || selectivePageBuilding) && new ServerlessPlugin(buildId, { isServer }),
      target !== 'serverless' && isServer && new PagesManifestPlugin(),
      target !== 'serverless' && isServer && new NextJsSSRModuleCachePlugin({ outputPath }),
      isServer && new NextJsSsrImportPlugin(),
      !isServer && new BuildManifestPlugin(),
      config.experimental.profiling && new webpack.debug.ProfilingPlugin({
        outputPath: path.join(distDir, `profile-events-${isServer ? 'server' : 'client'}.json`)
      })
    ].filter(Boolean as any as ExcludesFalse)
  }

  if (typeof config.webpack === 'function') {
    webpackConfig = config.webpack(webpackConfig, { dir, dev, isServer, buildId, config, defaultLoaders, totalPages, webpack })

    // @ts-ignore: Property 'then' does not exist on type 'Configuration'
    if (typeof webpackConfig.then === 'function') {
      console.warn('> Promise returned in next config. https://err.sh/zeit/next.js/promise-in-next-config.md')
    }
  }

  // Backwards compat for `main.js` entry key
  const originalEntry: any = webpackConfig.entry
  if (typeof originalEntry !== 'undefined') {
    webpackConfig.entry = async () => {
      const entry: WebpackEntrypoints = typeof originalEntry === 'function' ? await originalEntry() : originalEntry
      // Server compilation doesn't have main.js
      if (clientEntries && entry['main.js'] && entry['main.js'].length > 0) {
        const originalFile = clientEntries[CLIENT_STATIC_FILES_RUNTIME_MAIN]
        entry[CLIENT_STATIC_FILES_RUNTIME_MAIN] = [
          ...entry['main.js'],
          originalFile
        ]
      }
      delete entry['main.js']

      return entry
    }
  }

  if(!dev) {
    // @ts-ignore entry is always a function
    webpackConfig.entry = await webpackConfig.entry()
  }

  return webpackConfig
}
