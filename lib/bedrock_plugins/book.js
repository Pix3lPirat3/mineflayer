module.exports = inject

// Writable-book editing on Bedrock (book_edit packet). writeBook replaces each page's text; signBook signs the book,
// turning writable_book into written_book. The vanilla client is authoritative for book content: book_edit INFORMS the
// server and the client updates its own inventory locally (the server sends no echo back), so this plugin both sends the
// protocol-correct packets AND reflects the result into bot.inventory the way a real client would. inventory_slot in
// book_edit is the hotbar slot index (0-8) of the held book; a Java inventory slot 36..44 maps to hotbar 0..8.
function inject (bot) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }
  const hotbarIndex = (slot) => (slot >= 36 ? slot - 36 : slot)
  const Item = () => require('prismarine-item')(bot.registry)
  // The held/target book lives at a hotbar bedrock slot (0-8); its Java inventory slot is 36 + that.
  const javaSlotOf = (bedrockHotbar) => 36 + bedrockHotbar

  // Build the Bedrock book NBT (pages list + optional written-book title/author). prismarine-item stores nbt in the
  // {type,name,value} shape; a page is a compound { text: <string> }.
  const bookNbt = (pages, signed) => {
    const value = {
      pages: { type: 'list', value: { type: 'compound', value: (pages || []).map(text => ({ text: { type: 'string', value: String(text ?? '') } })) } }
    }
    if (signed) {
      value.title = { type: 'string', value: String(signed.title ?? '') }
      value.author = { type: 'string', value: String(signed.author ?? '') }
      value.xuid = { type: 'string', value: String(signed.xuid ?? '') }
      value.generation = { type: 'int', value: 0 } // 0 = original
    }
    return { type: 'compound', name: '', value }
  }

  // Track the pages written per bedrock hotbar slot so signBook can carry them into the written_book.
  const pagesBySlot = {}

  // Write pages into a writable_book at inventory `slot` (defaults to the currently held slot). `pages` is an array of
  // strings (one per page). Sends a book_edit replace_page per page and reflects the pages onto the local item.
  bot.writeBook = async (slot, pages) => {
    if (Array.isArray(slot)) { pages = slot; slot = null } // allow writeBook(pages)
    const bedrockSlot = slot == null ? bot.quickBarSlot : hotbarIndex(slot)
    if (!Array.isArray(pages)) throw new Error('writeBook: pages must be an array of strings')
    for (let i = 0; i < pages.length; i++) {
      send('book_edit', { inventory_slot: bedrockSlot, type: 'replace_page', page_number: i, text: String(pages[i] ?? ''), photo_name: '' })
      await wait(120)
    }
    pagesBySlot[bedrockSlot] = pages.slice()
    // Reflect the pages onto the local writable_book item.
    const js = javaSlotOf(bedrockSlot)
    const item = bot.inventory.slots[js]
    if (item && /writable_book/.test(item.name || '')) { try { item.nbt = bookNbt(pages, null) } catch {} bot.inventory.updateSlot(js, item) }
    return pages.length
  }

  // Sign the book (writable_book -> written_book) with a title and author. Sends the book_edit sign packet and converts
  // the local held item to a written_book carrying the pages + title/author, matching what the vanilla client shows.
  bot.signBook = async (slot, a, b, c) => {
    // Accept mineflayer-java's signBook(slot, pages, author, title) as well as the Bedrock signBook(slot, title, author)
    // and the shorthand signBook(title, author).
    let title, author, pages
    if (Array.isArray(a)) { // Java signature: signBook(slot, pages, author, title)
      pages = a; author = b; title = c
    } else if (typeof slot === 'string') { // shorthand: signBook(title, author)
      title = slot; author = a; slot = null
    } else { // Bedrock signature: signBook(slot, title, author)
      title = a; author = b
    }
    if (pages) { try { await bot.writeBook(slot, pages) } catch { /* best effort - pages may already be written */ } }
    const bedrockSlot = slot == null ? bot.quickBarSlot : hotbarIndex(slot)
    const xuid = String(bot._client.profile?.xuid ?? '')
    send('book_edit', { inventory_slot: bedrockSlot, type: 'sign', title: String(title ?? ''), author: String(author ?? bot.username ?? ''), xuid })
    await wait(200)
    // Convert the local item to a written_book (the server accepts the sign; the client owns the item state).
    const js = javaSlotOf(bedrockSlot)
    const src = bot.inventory.slots[js]
    const writtenId = bot.registry.itemsByName?.written_book?.id
    if (src && writtenId != null && /writable_book/.test(src.name || '')) {
      const pages = pagesBySlot[bedrockSlot] || []
      const written = new (Item())(writtenId, src.count, 0)
      try { written.nbt = bookNbt(pages, { title, author: author ?? bot.username, xuid }) } catch {}
      bot.inventory.updateSlot(js, written)
      delete pagesBySlot[bedrockSlot]
      return written
    }
    return null
  }
}
