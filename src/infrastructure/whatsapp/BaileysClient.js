import path from 'path'
import { EventEmitter } from 'events'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { env } from '../../config/env.js'

// proto.WebMessageInfo.Status — o número cru não diz nada pra quem consome.
const STATUS_LABELS = {
  0: 'error',
  1: 'pending',
  2: 'sent',
  3: 'delivered',
  4: 'read',
  5: 'played',
}

export class BaileysClient extends EventEmitter {
  #socket = null
  #sessionId
  #sessionsDir
  #isShuttingDown = false
  #phoneNumber = null
  #pendingSetup = false
  #pairingCodeRequested = false

  constructor(sessionId) {
    super()
    this.#sessionId = sessionId
    this.#sessionsDir = path.resolve(env.SESSIONS_DIR)
  }

  get sessionId() {
    return this.#sessionId
  }

  get socket() {
    return this.#socket
  }

  get isAuthenticated() {
    return this.#socket?.user?.id != null
  }

  async connect(phoneNumber = null) {
    this.#phoneNumber = phoneNumber ? phoneNumber.replace(/\D/g, '') : null
    this.#pendingSetup = true

    const authDir = path.join(this.#sessionsDir, `md_${this.#sessionId}`)
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const logger = pino({ level: 'silent' })

    this.#socket = makeWASocket({
      // Default do Baileys é true: o número ficaria "online" 24 horas por dia,
      // o que nenhum humano faz — e ainda suprime push notification no aparelho
      // pareado.
      markOnlineOnConnect: false,
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.macOS('Chrome'),
      logger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    this.#socket.ev.on('creds.update', saveCreds)
    this.#bindConnectionEvents()
    this.#bindMessageEvents()
  }

  async close() {
    this.#isShuttingDown = true
    this.#pendingSetup = false

    if (this.#socket) {
      this.#socket.end()
      this.#socket = null
    }
  }

  async disconnect() {
    this.#isShuttingDown = true
    this.#pendingSetup = false

    if (this.#socket) {
      await this.#socket.logout().catch(() => {})
      this.#socket.end()
      this.#socket = null
    }
  }

  async sendMessage(jid, content, options = {}) {
    if (!this.#socket) {
      throw new Error(`Socket da sessão '${this.#sessionId}' não está disponível`)
    }

    const delay = Math.floor(Math.random() * 3000) + 1000
    await new Promise((resolve) => setTimeout(resolve, delay))

    // `quoted` é o que faz o WhatsApp renderizar a citação da mensagem original.
    // O Baileys aceita a mensagem inteira ou um stub com key + message.
    return this.#socket.sendMessage(jid, content, options.quoted ? { quoted: options.quoted } : undefined)
  }

  /**
   * Envia um proto.IMessage arbitrário.
   *
   * A API tipada do Baileys (AnyRegularMessageContent) não expõe botão: só
   * text/mídia/poll/location/contacts/react/etc. Mas o protocolo continua
   * carregando ButtonsMessage (campo 42), InteractiveMessage (45) e ListMessage
   * (36) — o que sumiu foi o atalho, não a capacidade. Montando o proto na mão e
   * relayando dá pra enviar os três.
   *
   * Aviso honesto: o servidor da Meta pode recusar/filtrar interativos de conta
   * que não é Business API verificada, e a renderização varia por versão do app
   * do destinatário. Por isso quem chama isso é o SendButtonsUseCase, que degrada
   * em cascata até a enquete (essa sim nativa e garantida).
   */
  async sendRawMessage(jid, message) {
    if (!this.#socket) {
      throw new Error(`Socket da sessão '${this.#sessionId}' não está disponível`)
    }

    const delay = Math.floor(Math.random() * 3000) + 1000
    await new Promise((resolve) => setTimeout(resolve, delay))

    const generated = generateWAMessageFromContent(jid, message, {
      userJid: this.#socket.user?.id,
    })

    await this.#socket.relayMessage(jid, generated.message, {
      messageId: generated.key.id,
    })

    return generated
  }

  /**
   * Presença ("digitando…", "gravando…").
   *
   * É o ÚNICO sinal client-side que a Meta documenta explicitamente como
   * critério de banimento: "If an account continually sends messages without
   * triggering the typing indicator, it can be a signal of abuse, and we will
   * ban the account." Custo baixíssimo, respaldo oficial direto.
   */
  async sendPresence(jid, presence = 'composing') {
    if (!this.#socket) {
      throw new Error(`Socket da sessão '${this.#sessionId}' não está disponível`)
    }
    await this.#socket.presenceSubscribe(jid).catch(() => {})
    return this.#socket.sendPresenceUpdate(presence, jid)
  }

  /** Recibo de leitura (tique azul). Humano lê antes de responder. */
  async readMessages(keys) {
    if (!this.#socket) {
      throw new Error(`Socket da sessão '${this.#sessionId}' não está disponível`)
    }
    return this.#socket.readMessages(keys)
  }

  async onWhatsApp(...jids) {
    if (!this.#socket) {
      throw new Error(`Socket da sessão '${this.#sessionId}' não está disponível`)
    }

    return this.#socket.onWhatsApp(...jids)
  }

  getChats() {
    if (!this.#socket?.store) return []
    return Object.values(this.#socket.store.chats ?? {})
  }

  async getGroupMetadata(jid) {
    if (!this.#socket) {
      throw new Error(`Socket da sessão '${this.#sessionId}' não está disponível`)
    }

    return this.#socket.groupMetadata(jid)
  }

  #bindConnectionEvents() {
    this.#socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        if (this.#phoneNumber && !this.#socket.authState?.creds?.registered) {
          if (this.#pairingCodeRequested) return
          this.#pairingCodeRequested = true
          try {
            const code = await this.#socket.requestPairingCode(this.#phoneNumber)
            const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
            this.#pendingSetup = false
            this.emit('pairing_code', formatted)
          } catch (err) {
            this.#pairingCodeRequested = false
            this.#pendingSetup = false
            this.emit('setup_failed', err.message)
          }
        } else {
          const { toDataURL } = await import('qrcode')
          const qrBase64 = await toDataURL(qr)
          this.#pendingSetup = false
          this.emit('qr', qrBase64)
        }
      }

      if (connection === 'open') {
        this.#pendingSetup = false
        this.emit('connected')

        const phoneNumber = this.#socket?.user?.id
          ? this.#socket.user.id.split(':')[0]
          : null

        if (phoneNumber) {
          this.emit('authenticated', phoneNumber)
        }
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
        // `forbidden` (403) é o sinal de BAN, e estava classificado como
        // "reconecta": um número banido entrava em loop de reconexão e o alerta
        // de sessão perdida nunca disparava — o produto morria em silêncio, e
        // martelar reconexão contra um número bloqueado escala bloqueio
        // temporário para permanente. `connectionReplaced` (440) é outra sessão
        // assumindo o número: insistir aqui vira cabo de guerra entre as duas.
        const TERMINAL_CODES = new Set([
          DisconnectReason.loggedOut,
          DisconnectReason.forbidden,
          DisconnectReason.connectionReplaced,
        ])
        const shouldReconnect = !TERMINAL_CODES.has(statusCode)
        const reason = DisconnectReason[statusCode] ?? 'unknown'

        if (this.#pendingSetup) {
          this.#pendingSetup = false
          this.emit('setup_failed', reason)
          return
        }

        this.emit(
          'disconnected',
          reason,
          shouldReconnect && !this.#isShuttingDown,
          statusCode
        )
      }
    })
  }

  #bindMessageEvents() {
    this.#socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return

      for (const message of messages) {
        if (!message.message) continue
        this.emit('message', message, this.#sessionId)
      }
    })

    // Recibos de entrega. Sem isto quem consome o gateway fica CEGO: o único
    // registro de saída seria "o Baileys aceitou a stanza", que não é o mesmo
    // que "o usuário recebeu". Sessão despareada, número banido e entrega
    // normal ficariam indistinguíveis — e qualquer sentinela que conte falhas
    // de entrega viraria falso-verde.
    this.#socket.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (update?.status === undefined || update?.status === null) continue
        this.emit('message-status', {
          messageId: key?.id ?? null,
          jid: key?.remoteJid ?? null,
          fromMe: key?.fromMe ?? false,
          status: STATUS_LABELS[update.status] ?? String(update.status),
        }, this.#sessionId)
      }
    })
  }
}
