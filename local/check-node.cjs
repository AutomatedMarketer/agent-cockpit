// Says in plain words whether this computer's Node is new enough for the board. Plain CommonJS with
// old-style syntax on purpose: it has to run (and explain) on a Node too old for the rest of the board.
var MIN_MAJOR = 20

function nodeIsNewEnough(version) {
  var match = /^v?(\d+)\./.exec(String(version || ''))
  return !!match && Number(match[1]) >= MIN_MAJOR
}

module.exports = { nodeIsNewEnough: nodeIsNewEnough, MIN_MAJOR: MIN_MAJOR }

if (require.main === module) {
  // BOARD_FAKE_NODE_VERSION lets a test play an old Node without having one.
  var version = process.env.BOARD_FAKE_NODE_VERSION || process.versions.node
  if (!nodeIsNewEnough(version)) {
    console.log('')
    console.log('This computer has Node ' + version + ', and the board needs Node ' + MIN_MAJOR + ' or newer.')
    console.log('Install the current LTS version from https://nodejs.org , then double-click Start Board again.')
    process.exit(1)
  }
}
