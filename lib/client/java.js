// Java client adapter: the node-minecraft-protocol client, unchanged behaviour.
const mc = require('minecraft-protocol')

module.exports = { createClient }

function createClient (options) {
  return mc.createClient(options)
}
