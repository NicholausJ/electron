#!/usr/bin/env node

const { GitProcess } = require('dugite')
const childProcess = require('child_process')
const klaw = require('klaw')
const minimist = require('minimist')
const path = require('path')
const pluralize = require('pluralize')

const SOURCE_ROOT = path.normalize(path.dirname(__dirname))

const BLACKLIST = new Set([
  ['atom', 'browser', 'mac', 'atom_application.h'],
  ['atom', 'browser', 'mac', 'atom_application_delegate.h'],
  ['atom', 'browser', 'resources', 'win', 'resource.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'atom_menu_controller.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'atom_ns_window.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'atom_ns_window_delegate.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'atom_preview_item.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'atom_touch_bar.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'touch_bar_forward_declarations.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'NSColor+Hex.h'],
  ['atom', 'browser', 'ui', 'cocoa', 'NSString+ANSI.h'],
  ['atom', 'common', 'api', 'api_messages.h'],
  ['atom', 'common', 'common_message_generator.cc'],
  ['atom', 'common', 'common_message_generator.h'],
  ['atom', 'common', 'node_includes.h'],
  ['atom', 'node', 'osfhandle.cc'],
  ['brightray', 'browser', 'mac', 'bry_inspectable_web_contents_view.h'],
  ['brightray', 'browser', 'mac', 'event_dispatching_window.h'],
  ['brightray', 'browser', 'mac', 'notification_center_delegate.h'],
  ['brightray', 'browser', 'win', 'notification_presenter_win7.h'],
  ['brightray', 'browser', 'win', 'win32_desktop_notifications', 'common.h'],
  ['brightray', 'browser', 'win', 'win32_desktop_notifications',
    'desktop_notification_controller.cc'],
  ['brightray', 'browser', 'win', 'win32_desktop_notifications',
    'desktop_notification_controller.h'],
  ['brightray', 'browser', 'win', 'win32_desktop_notifications', 'toast.h'],
  ['brightray', 'browser', 'win', 'win32_notification.h']
].map(tokens => path.join(SOURCE_ROOT, ...tokens)))

const LINTERS = [
  {
    key: 'c++',
    roots: ['atom', 'brightray'].map(x => path.join(SOURCE_ROOT, x)),
    test: filename => filename.endsWith('.cc') || filename.endsWith('.h'),
    run: async (filenames) => {
      childProcess.execFile('cpplint.py', filenames, {}, (error, stdout, stderr) => {
        // cpplint writes warnings, errors, AND status messages to stderr.
        // prune out the status messages:
        for (const line of stderr.split(/[\r\n]+/)) {
          if (line.length && !line.startsWith('Done processing ') && line !== 'Total errors found: 0') {
            console.warn(line)
          }
        }
        if (error || stderr.includes('Command failed')) {
          process.exit(1)
        }
      })
    }
  }, {
    key: 'python',
    roots: ['script'].map(x => path.join(SOURCE_ROOT, x)),
    test: filename => filename.endsWith('.py'),
    run: async (filenames) => {
      const rcfile = path.normalize(path.join(SOURCE_ROOT, '..', 'third_party', 'depot_tools', 'pylintrc'))
      const args = ['--rcfile=' + rcfile, ...filenames]
      const env = Object.assign({PYTHONPATH: path.join(SOURCE_ROOT, 'script')}, process.env)
      childProcess.execFile('pylint.py', args, { env }, (unused, stdout, stderr) => {
        if (!stdout.length && !stderr.length) { // pylint is quiet on success
          return
        }
        console.warn(stdout, stderr)
        process.exit(1)
      })
    }
  }, {
    key: 'javascript',
    roots: ['lib', 'script'].map(x => path.join(SOURCE_ROOT, x)),
    test: filename => filename.endsWith('.js'),
    run: async (filenames) => {
      const cmd = path.join(SOURCE_ROOT, 'node_modules', '.bin', 'standard')
      childProcess.execFile(cmd, filenames, { cwd: SOURCE_ROOT }, (error, stdout, stderr) => {
        if (!error) { // standard is quiet on success
          return
        }
        console.warn(stdout)
        process.exit(1)
      })
    }
  }, {
    key: 'javascript',
    roots: ['spec'].map(x => path.join(SOURCE_ROOT, x)),
    test: filename => filename.endsWith('.js'),
    run: async (filenames) => {
      const cmd = path.join(SOURCE_ROOT, 'node_modules', '.bin', 'standard')
      childProcess.execFile(cmd, filenames, { cwd: path.join(SOURCE_ROOT, 'spec') }, (error, stdout, stderr) => {
        if (!error) { // standard is quiet on success
          return
        }
        console.warn(stdout)
        process.exit(1)
      })
    }
  }
]

function parseCommandLine () {
  let help
  const opts = minimist(process.argv.slice(2), {
    boolean: ['c++', 'javascript', 'python', 'help', 'changed'],
    alias: {'c++': ['cc', 'cpp', 'cxx'], javascript: ['js', 'es'], python: 'py', changed: 'c', help: 'h'},
    unknown: arg => { help = true }
  })
  if (help || opts.help) {
    console.log('Usage: script/lint.js [--cc] [--js] [--py] [-c|--changed] [-h|--help]')
    process.exit(0)
  }
  return opts
}

async function findChangedFiles (top) {
  const result = await GitProcess.exec(['diff', 'HEAD', '--name-only'], top)
  if (result.exitCode !== 0) {
    console.log('Failed to find changed files', GitProcess.parseError(result.stderr))
    process.exit(1)
  }
  const relativePaths = result.stdout.split(/\r\n|\r|\n/g)
  const absolutePaths = relativePaths.map(x => path.join(top, x))
  return new Set(absolutePaths)
}

async function findMatchingFiles (top, test) {
  return new Promise((resolve, reject) => {
    const matches = []
    klaw(top)
      .on('end', () => resolve(matches))
      .on('data', item => {
        if (test(item.path)) {
          matches.push(item.path)
        }
      })
  })
}

async function findFiles (args, linter) {
  let filenames = []
  let whitelist

  // build the whitelist
  if (args.changed) {
    whitelist = await findChangedFiles(SOURCE_ROOT)
    if (!whitelist.length) {
      return filenames
    }
  } else {
    whitelist = new Set()
  }

  // accumulate the raw list of files
  for (const root of linter.roots) {
    const files = await findMatchingFiles(root, linter.test)
    filenames.push(...files)
  }

  // remove blacklisted files
  filenames = filenames.filter(x => !BLACKLIST.has(x))

  // if a whitelist exists, remove anything not in it
  if (whitelist.length) {
    filenames = filenames.filter(x => whitelist.has(x))
  }

  return filenames
}

async function main () {
  const args = parseCommandLine()

  // no mode specified? run 'em all
  if (!args['c++'] && !args.javascript && !args.python) {
    args['c++'] = args.javascript = args.python = true
  }

  const linters = LINTERS.filter(x => args[x.key])

  for (const linter of linters) {
    const filenames = await findFiles(args, linter)
    if (filenames.length) {
      console.log(`linting ${filenames.length} ${linter.key} ${pluralize('file', filenames.length)}`)
      await linter.run(filenames)
    }
  }
}

if (process.mainModule === module) {
  main()
}
