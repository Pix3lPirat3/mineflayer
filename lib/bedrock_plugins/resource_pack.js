module.exports = inject

// Resource-pack parity for Bedrock. mineflayer-java exposes bot.acceptResourcePack()/denyResourcePack() and a
// 'resourcePack' event; the login handshake already negotiates packs to reach spawn (client/bedrock), so these are the
// on-demand equivalents. On Bedrock the client answers with resource_pack_client_response (response_status mapper:
// refused / send_packs / have_all_packs / completed). We emit 'resourcePack' when the server advertises packs and let
// the caller accept (completed) or deny (refused). Wrapped defensively so a protocol-shape change can never crash a bot.
function inject (bot) {
  const send = (name, packet) => { try { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) } catch {} }
  const respond = (status) => send('resource_pack_client_response', { response_status: status, response_status_name: '', resourcepackids: [] })

  // Surface pack offers. Java's 'resourcePack' event is (url, hash) for ONE pack, so a Java-written handler
  // `bot.on('resourcePack', (url, hash) => ...)` expects two scalars. Bedrock advertises a LIST of packs with no download
  // URL, so emit Java-shaped (identifier, version) per pack (uuid as the identifier, content version as the hash-ish), and
  // keep the full array under a bedrock-only 'resourcePackInfo' event so nothing is lost.
  bot._client.on('resource_packs_info', (packet) => {
    const packs = (packet && (packet.texture_packs || packet.resource_pack_infos || packet.behaviour_packs)) || []
    bot.emit('resourcePackInfo', packs, packet)
    for (const pack of packs) {
      const id = pack.uuid ?? pack.content_identity ?? pack.pack_id ?? null
      const version = pack.version ?? pack.content_key ?? ''
      bot.emit('resourcePack', id, version)
    }
  })

  // Accept = tell the server we have all the packs and are done (the two-step have_all_packs -> completed the client
  // uses at login). Safe to call post-spawn; the server has already been told at login, this just re-affirms.
  bot.acceptResourcePack = () => { respond('have_all_packs'); respond('completed') }
  // Deny = refuse the pack set. Matches Java's denyResourcePack; a server that requires packs may then disconnect.
  bot.denyResourcePack = () => { respond('refused') }
}
