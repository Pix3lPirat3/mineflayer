const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  const Chunk = bot.registry.blockStates ? require('prismarine-chunk')(bot.registry) : null
  const World = require('prismarine-world')(bot.registry)
  let world = new World(null).sync
  const chunks = new Map()
  const loadedChunks = new Set()
  const pendingSections = new Map()
  let dimension = 0
  let blockDataSupported = false
  let blockDataUnsupportedReason = 'Bedrock block registry data is unavailable'
  bot._bedrockWorldSupport = { supported: false, reason: blockDataUnsupportedReason }
  let listener
  let listenerRemove

  bot.world = world
  startListenerProxy()
  bot.blockAt = position => world.getBlock(position)
  bot.waitForChunksToLoad = waitForChunksToLoad

  // World-query helpers, matching the Java plugin's API. Pure reads over loaded chunks (no packets), so they are safe
  // on a server-authoritative Bedrock connection. This is a correctness-first cube scan around the point; sparse large
  // searches are O(range^3) blockAt calls, so keep maxDistance modest.
  function blockMatcher (matching) {
    if (typeof matching === 'function') return matching
    const wanted = Array.isArray(matching) ? matching : [matching]
    const ids = new Set()
    for (const m of wanted) {
      if (m == null) continue
      if (typeof m === 'number') ids.add(m)
      else if (typeof m === 'string') { const id = bot.registry.blocksByName[m.replace(/^minecraft:/, '')]?.id; if (id != null) ids.add(id) }
    }
    return (block) => !!block && block.name !== 'air' && ids.has(block.type)
  }

  bot.findBlocks = (options = {}) => {
    const match = blockMatcher(options.matching)
    const point = (options.point || bot.entity.position).floored()
    const maxDistance = options.maxDistance || 16
    const count = options.count || 1
    const found = []
    for (let dx = -maxDistance; dx <= maxDistance; dx++) {
      for (let dz = -maxDistance; dz <= maxDistance; dz++) {
        for (let dy = -maxDistance; dy <= maxDistance; dy++) {
          const p = point.offset(dx, dy, dz)
          if (p.distanceTo(point) > maxDistance) continue
          let block
          try { block = world.getBlock(p) } catch (e) { continue }
          if (match(block)) found.push(p)
        }
      }
    }
    found.sort((a, b) => a.distanceTo(point) - b.distanceTo(point))
    return found.slice(0, count)
  }

  bot.findBlock = (options = {}) => {
    const points = bot.findBlocks({ ...options, count: 1 })
    return points.length ? world.getBlock(points[0]) : null
  }

  bot._client.on('start_game', packet => {
    dimension = normalizeDimension(packet.dimension)
    blockDataUnsupportedReason = blockDataSupportReason(packet)
    blockDataSupported = blockDataUnsupportedReason === null
    updateWorldSupport()
  })

  bot._client.on('level_chunk', packet => {
    decodeLevelChunk(packet).catch(disableBlockData)
  })

  bot._client.on('subchunk', packet => {
    decodeSubChunks(packet).catch(disableBlockData)
  })

  bot._client.on('update_block', packet => {
    const position = packet.position ?? packet.coordinates
    const layer = packet.layer ?? packet.storage ?? 0
    if (position && layer === 0) updateBlock(position, packet.block_runtime_id)
  })

  bot._client.on('update_block_synced', packet => {
    if (packet.position && (packet.layer ?? 0) === 0) updateBlock(packet.position, packet.block_runtime_id)
  })

  bot._client.on('update_subchunk_blocks', packet => {
    for (const update of packet.blocks || []) updateBlock(update.position, update.runtime_id)
  })

  bot._client.on('block_entity_data', packet => {
    const column = packet.position && getColumnAt(packet.position)
    if (!column) return
    column.setBlockEntity(localPosition(packet.position), packet.nbt)
  })

  bot._client.on('change_dimension', packet => {
    dimension = normalizeDimension(packet.dimension)
    resetWorld()
  })

  async function decodeLevelChunk (packet) {
    if (!blockDataSupported) return
    const key = chunkKey(packet.x, packet.z)
    const column = getOrCreateColumn(packet.x, packet.z)
    const polling = packet.highest_subchunk_count != null && packet.sub_chunk_count === 0

    if (packet.cache_enabled) {
      throw new Error('Cached Bedrock chunks are not supported yet')
    }

    if (!polling) {
      column.networkDecodeNoCache(packet.payload, packet.sub_chunk_count)
      world.setColumn(packet.x, packet.z, column)
      loadedChunks.add(key)
      pendingSections.delete(key)
      return
    }

    const sectionCount = packet.highest_subchunk_count
    if (!Number.isInteger(sectionCount) || sectionCount < 0 || sectionCount > 256) {
      throw new Error(`Invalid Bedrock subchunk count: ${sectionCount}`)
    }

    const minimumSection = Math.floor(bot.game.minY / 16)
    const sections = new Set(Array.from({ length: sectionCount }, (_, index) => minimumSection + index))
    pendingSections.set(key, sections)
    if (sections.size === 0) {
      loadedChunks.add(key)
      return
    }

    bot._client.queue('subchunk_request', {
      dimension: packet.dimension ?? dimension,
      origin: { x: packet.x, y: minimumSection, z: packet.z },
      requests: [...sections].map(sectionY => ({ x: 0, y: sectionY - minimumSection, z: 0 }))
    })
  }

  async function decodeSubChunks (packet) {
    if (!blockDataSupported) return
    for (const entry of packet.entries || []) {
      const chunkX = packet.origin.x + entry.dx
      const sectionY = packet.origin.y + entry.dy
      const chunkZ = packet.origin.z + entry.dz
      const key = chunkKey(chunkX, chunkZ)
      const column = getOrCreateColumn(chunkX, chunkZ)

      if (entry.result === 'success' || entry.result === 1) {
        if (packet.cache_enabled) throw new Error('Cached Bedrock subchunks are not supported yet')
        if (!entry.payload) throw new Error(`Bedrock subchunk ${chunkX},${sectionY},${chunkZ} has no payload`)
        await column.networkDecodeSubChunkNoCache(sectionY, entry.payload)
      } else if (entry.result !== 'success_all_air' && entry.result !== 6) {
        continue
      }

      const pending = pendingSections.get(key)
      pending?.delete(sectionY)
      if (pending?.size === 0) {
        pendingSections.delete(key)
        world.setColumn(chunkX, chunkZ, column)
        loadedChunks.add(key)
      }
    }
  }

  function getOrCreateColumn (chunkX, chunkZ) {
    const key = chunkKey(chunkX, chunkZ)
    let column = chunks.get(key)
    if (column) return column
    column = new Chunk({ x: chunkX, z: chunkZ })
    chunks.set(key, column)
    return column
  }

  function updateBlock (position, runtimeId) {
    if (!blockDataSupported) return
    const point = new Vec3(position.x, signedCoordinate(position.y), position.z)
    const column = getColumnAt(point)
    const block = bot.registry.blocksByRuntimeId?.[runtimeId]
    if (!column) return
    if (!block) {
      if (bot._bedrockWorldSupport) bot._bedrockWorldSupport.lastWarning = `Unknown block runtime ID ${runtimeId}`
      bot.emit('blockUpdateError', point, runtimeId)
      return
    }
    if (world.getColumnAt(point)) world.setBlockStateId(point, block.stateId)
    else column.setBlockStateId(localPosition(point), block.stateId)
  }

  function waitForChunksToLoad () {
    const center = bot.entity.position
    const expected = new Set()
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        expected.add(chunkKey(Math.floor(center.x / 16) + x, Math.floor(center.z / 16) + z))
      }
    }
    for (const key of loadedChunks) expected.delete(key)
    if (expected.size === 0) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`Timeout waiting for ${expected.size} Bedrock chunks to load`))
      }, 10000)
      const interval = setInterval(() => {
        for (const key of loadedChunks) expected.delete(key)
        if (expected.size !== 0) return
        clearTimeout(timeout)
        clearInterval(interval)
        resolve()
      }, 50)
    })
  }

  function startListenerProxy () {
    if (listener) {
      bot.off('newListener', listener)
      bot.off('removeListener', listenerRemove)
    }
    for (const event of ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']) {
      world.on(event, (...args) => bot.emit(event, ...args))
    }
    const blockUpdate = /^blockUpdate:\(-?\d+, -?\d+, -?\d+\)$/
    listener = (event, handler) => {
      if (blockUpdate.test(event)) world.on(event, handler)
    }
    listenerRemove = (event, handler) => {
      if (blockUpdate.test(event)) world.off(event, handler)
    }
    bot.on('newListener', listener)
    bot.on('removeListener', listenerRemove)
  }

  function blockDataSupportReason (packet) {
    if (!Chunk) return 'minecraft-data has no block registry for this version'
    if (!bot.registry.blocksByRuntimeId) return 'prismarine-registry did not create a runtime block table'
    if (!packet.block_network_ids_are_hashes) return null
    if (!bot.registry.supportFeature('blockHashes')) return 'minecraft-data does not mark this hashed-runtime version'
    // With hashed runtime ids the block index tables are keyed by the state hash, so blocksByStateId (not the
    // index-ordered blockStates array) is the correct lookup for a block's default state.
    const table = bot.registry.blocksByStateId
    const aligned = Object.values(bot.registry.blocksByName).every(block => {
      return table[block.defaultState]?.name === block.name
    })
    return aligned ? null : 'minecraft-data blockStates and blocksByStateId are misaligned'
  }

  function disableBlockData (error) {
    if (!blockDataSupported) return
    blockDataSupported = false
    blockDataUnsupportedReason = error.message
    resetWorld()
    bot._warn(`Bedrock block data is unavailable for ${bot.version}: ${error.message}`)
  }

  function updateWorldSupport () {
    bot._bedrockWorldSupport = {
      supported: blockDataSupported,
      reason: blockDataUnsupportedReason
    }
  }

  function getColumnAt (position) {
    return world.getColumnAt(position) || chunks.get(chunkKey(Math.floor(position.x / 16), Math.floor(position.z / 16)))
  }

  function resetWorld () {
    for (const key of loadedChunks) {
      const [chunkX, chunkZ] = key.split(',').map(Number)
      world.unloadColumn(chunkX, chunkZ)
    }
    chunks.clear()
    loadedChunks.clear()
    pendingSections.clear()
    world = new World(null).sync
    bot.world = world
    updateWorldSupport()
    startListenerProxy()
  }
}

function chunkKey (x, z) {
  return `${x},${z}`
}

function localPosition (position) {
  return new Vec3(position.x & 15, signedCoordinate(position.y), position.z & 15)
}

function signedCoordinate (value) {
  return value > 0x7fffffff ? value - 0x100000000 : value
}

function normalizeDimension (value) {
  if (typeof value === 'number') return value
  if (value === 'nether' || value === 'the_nether' || value === 'minecraft:nether') return 1
  if (value === 'end' || value === 'the_end' || value === 'minecraft:end') return 2
  return 0
}
