// Bedrock client adapter: creates the bedrock-protocol client and performs the join sequence the way the official
// client does (captured from a 1.26.51 Windows client against an official dedicated server), so the rest of
// mineflayer only sees the usual connect / login / spawn / end lifecycle.
//
// Sequence of the real client after the resource pack phase (bedrock-protocol handles the packs and the chunk
// radius): serverbound_loading_screen start, client_camera_aim_assist clear, set_local_player_as_initialized together with
// loading screen end, then player_auth_input every tick. It never sends client_cache_status.
const bedrock = require('bedrock-protocol')

module.exports = { createClient, normalizeVersion }

// Versions reach minecraft-data with the bedrock_ prefix and bedrock-protocol without it.
function normalizeVersion (version) {
  if (!version || version === false || version === 'bedrock') return { data: null, protocol: null }
  const bare = String(version).startsWith('bedrock_') ? String(version).slice('bedrock_'.length) : String(version)
  return { data: 'bedrock_' + bare, protocol: bare }
}

function createClient (options) {
  const clientOptions = { ...options }
  for (const key of ['edition', 'client', 'plugins', 'loadInternalPlugins', 'logErrors', 'hideErrors', 'brand', 'respawn', 'validateChannelProtocol']) delete clientOptions[key]
  clientOptions.host = clientOptions.host ?? '127.0.0.1'
  clientOptions.port = clientOptions.port ?? 19132
  const { protocol } = normalizeVersion(options.version)
  if (protocol) clientOptions.version = protocol
  else delete clientOptions.version
  if (clientOptions.offline === undefined && !clientOptions.profilesFolder) clientOptions.offline = true
  // mineflayer drives the post-spawn packets itself (see below and lib/bedrock_plugins/client_input.js)
  clientOptions.autoInitPlayer = false
  clientOptions.skipPing = clientOptions.skipPing ?? false
  const client = bedrock.createClient(clientOptions)
  client.bedrock = true
  joinSequence(client, options)
  return client
}

function joinSequence (client, options) {
  const send = (name, params) => { if (typeof client.queue === 'function') client.queue(name, params); else client.write(name, params) }
  const after = (v) => client.registry?.version ? client.registry.version['>='](v) : (client.options?.protocolVersion ?? 0) >= v
  let startGame = null
  let initialized = false

  client.on('start_game', (packet) => { startGame = packet })
  client.on('play_status', (packet) => {
    if (packet.status !== 'player_spawn' || initialized) return
    initialized = true
    // the real client ends its loading screen and announces initialization back to back
    // bedrock-protocol's createClient already answers the resource pack phase and requests the chunk radius
    if (after(2168)) send('serverbound_loading_screen', { type: 1 })
    if (after(2168)) send('client_camera_aim_assist', { preset_id: '', action: 'clear', allow_aim_assist: false })
    send('set_local_player_as_initialized', { runtime_entity_id: startGame?.runtime_entity_id ?? client.entityId })
    if (after(2168)) send('serverbound_loading_screen', { type: 2 })
    client.status = 4 // ClientStatus.Initialized, as bedrock-protocol's own autoInitPlayer would set
    client.emit('spawn')
  })
}
