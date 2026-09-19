// Bedrock client adapter: creates the bedrock-protocol client and lets it drive the core join for every version
// (resource packs, chunk radius, set_local_player_as_initialized). On modern servers (protocol >= 2168) it adds the
// two extra packets the official 1.26.4x+ client sends around initialization, the loading screen and the aim-assist
// clear, so a bot looks like a real client without disabling the version-agnostic init bedrock-protocol already does.
const bedrock = require('bedrock-protocol')

module.exports = { createClient, normalizeVersion }

// Versions reach minecraft-data with the bedrock_ prefix and bedrock-protocol without it.
function normalizeVersion (version) {
  if (!version || version === false || version === 'bedrock') return { data: null, protocol: null }
  const bare = String(version).startsWith('bedrock_') ? String(version).slice('bedrock_'.length) : String(version)
  return { data: 'bedrock_' + bare, protocol: bare }
}

function createClient (options) {
  // Pass mineflayer's options through as bedrock-protocol does for its own createClient; only drop the two mineflayer
  // keys that would confuse it, and translate the version. Stripping more (plugins, brand, ...) broke the offline
  // login handshake on some servers, so keep the object intact.
  const clientOptions = { ...options }
  delete clientOptions.edition
  delete clientOptions.client
  clientOptions.host = clientOptions.host ?? '127.0.0.1'
  clientOptions.port = clientOptions.port ?? 19132
  const { protocol } = normalizeVersion(options.version)
  if (protocol) clientOptions.version = protocol
  else delete clientOptions.version
  if (clientOptions.offline === undefined && !clientOptions.profilesFolder) clientOptions.offline = true
  const client = bedrock.createClient(clientOptions)
  client.bedrock = true
  addClientAuthenticity(client)
  return client
}

// The official 1.26.4x+ client brackets set_local_player_as_initialized with a loading-screen start/end and clears the
// aim-assist preset. bedrock-protocol sends set_local_player_as_initialized itself, so this only fills in the extras,
// guarded to versions that have those packets. Servers that do not know them ignore an unknown clientbound-shaped
// packet; the guard keeps them off older protocols entirely.
function addClientAuthenticity (client) {
  const send = (name, params) => { try { if (typeof client.queue === 'function') client.queue(name, params); else client.write(name, params) } catch { /* packet not in this version's schema */ } }
  const protocolAtLeast = (v) => (client.options?.protocolVersion ?? 0) >= v
  let done = false
  client.on('play_status', (packet) => {
    if (packet.status !== 'player_spawn' || done || !protocolAtLeast(2168)) return
    done = true
    send('serverbound_loading_screen', { type: 1 })
    send('client_camera_aim_assist', { preset_id: '', action: 'clear', allow_aim_assist: false })
    send('serverbound_loading_screen', { type: 2 })
  })
}
