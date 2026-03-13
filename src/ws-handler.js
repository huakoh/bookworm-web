'use strict';

// ─── #12 WebSocket 实时通道 ───
// 基于原生 HTTP upgrade，无外部依赖
// 支持: 路由查询、Chat 流式、心跳

const crypto = require('crypto');
const { route } = require('./router-engine');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB5DC85B11B';

/**
 * 处理 WebSocket upgrade 请求
 */
function handleUpgrade(req, socket, head, verifyTokenFn) {
  // 验证 WebSocket 握手
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // 从 query 参数获取 token
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let userId;
  try {
    const result = verifyTokenFn('Bearer ' + token);
    userId = result.userId;
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // 完成 WebSocket 握手
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  // 设置 WebSocket 通信
  const ws = new WsConnection(socket, userId);
  ws.start();
}

class WsConnection {
  constructor(socket, userId) {
    this.socket = socket;
    this.userId = userId;
    this.alive = true;
  }

  start() {
    this.socket.on('data', (data) => this._onData(data));
    this.socket.on('close', () => { this.alive = false; });
    this.socket.on('error', () => { this.alive = false; });

    // 心跳 (每 30 秒 ping)
    this.pingTimer = setInterval(() => {
      if (!this.alive) { clearInterval(this.pingTimer); return; }
      this._sendFrame(Buffer.alloc(0), 0x09); // ping
    }, 30_000);

    this.send({ type: 'connected', userId: this.userId });
  }

  send(data) {
    const json = JSON.stringify(data);
    this._sendFrame(Buffer.from(json, 'utf8'), 0x01); // text frame
  }

  _sendFrame(payload, opcode) {
    if (!this.alive) return;
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.alive = false;
    }
  }

  _onData(data) {
    try {
      const frame = this._parseFrame(data);
      if (!frame) return;

      if (frame.opcode === 0x08) {
        // close
        this.alive = false;
        this.socket.end();
        clearInterval(this.pingTimer);
        return;
      }

      if (frame.opcode === 0x0a) return; // pong, ignore
      if (frame.opcode === 0x09) {
        // ping -> pong
        this._sendFrame(frame.payload, 0x0a);
        return;
      }

      // text frame
      if (frame.opcode === 0x01) {
        const msg = JSON.parse(frame.payload.toString('utf8'));
        this._handleMessage(msg);
      }
    } catch (e) {
      this.send({ type: 'error', message: e.message });
    }
  }

  _parseFrame(data) {
    if (data.length < 2) return null;
    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    let payloadLen = data[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      payloadLen = data.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      payloadLen = Number(data.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey = null;
    if (masked) {
      maskKey = data.subarray(offset, offset + 4);
      offset += 4;
    }

    let payload = data.subarray(offset, offset + payloadLen);
    if (masked && maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    return { opcode, payload };
  }

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'route': {
        const result = route(msg.text || '');
        this.send({ type: 'route_result', id: msg.id, ...result });
        break;
      }
      case 'ping': {
        this.send({ type: 'pong', ts: Date.now() });
        break;
      }
      default:
        this.send({ type: 'error', message: `未知消息类型: ${msg.type}` });
    }
  }
}

module.exports = { handleUpgrade };
