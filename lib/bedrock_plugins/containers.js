module.exports = inject

// Bedrock containers (chests, furnaces, ...). The server opens a container with container_open, streams its items with
// inventory_content for that window id, reports progress fields with container_set_data, and ends it with
// container_close. Opening one is a click_block on the container (bot.openContainer -> the interact plugin's
// activateBlock); the server then drives the rest. Packet shapes verified against a relay capture.
function inject (bot) {
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }

  bot._client.on('container_open', (packet) => {
    bot.currentWindow = {
      id: packet.window_id,
      type: packet.window_type,
      position: packet.coordinates ? { x: packet.coordinates.x, y: packet.coordinates.y, z: packet.coordinates.z } : null,
      entityId: packet.runtime_entity_id,
      slots: [],
      properties: {}
    }
    bot.emit('windowOpen', bot.currentWindow)
  })

  bot._client.on('inventory_content', (packet) => {
    const w = bot.currentWindow
    if (!w || packet.window_id !== w.id) return
    w.slots = (packet.input || []).map(it => (bot._bedrockItemFromNotch ? bot._bedrockItemFromNotch(it) : it) || null)
    bot.emit('windowUpdate', w)
  })

  bot._client.on('container_set_data', (packet) => {
    if (bot.currentWindow && packet.window_id === bot.currentWindow.id) bot.currentWindow.properties[packet.property] = packet.value
    bot.emit('containerProperty', packet.window_id, packet.property, packet.value)
  })

  bot._client.on('container_close', (packet) => {
    const w = bot.currentWindow
    bot.currentWindow = null
    if (w) bot.emit('windowClose', w)
  })

  // Close the current (or given) container. Bedrock echoes with its own container_close, which fires windowClose.
  bot.closeWindow = (window) => {
    const w = window || bot.currentWindow
    if (!w) return
    send('container_close', { window_id: w.id, window_type: w.type ?? 'none', server: false })
    bot.currentWindow = null
    bot.emit('windowClose', w)
  }

  // Open a container block (chest, furnace, ...). Uses the interact plugin's click_block; the server replies with
  // container_open. Best used with an empty hand so the click is not treated as a block placement.
  bot.openContainer = (block) => {
    if (typeof bot.activateBlock !== 'function') throw new Error('openContainer needs the interact plugin')
    return bot.activateBlock(block)
  }
}
