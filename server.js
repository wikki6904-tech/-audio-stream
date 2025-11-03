// server.js - WebSocket сервер для аудио стриминга
const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище активных стримов
const streams = new Map();

// Простой HTTP endpoint для проверки
app.get('/', (req, res) => {
  res.send('🎧 WebSocket Audio Server Running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: streams.size,
    timestamp: Date.now()
  });
});

// WebSocket подключения
wss.on('connection', (ws, req) => {
  console.log('🔌 Новое подключение');
  
  let clientType = null;
  let deviceId = null;
  let streamId = null;

  ws.on('message', (data) => {
    try {
      // Проверяем - это JSON команда или бинарные аудио-данные
      if (data[0] === 0x7B) { // '{' - начало JSON
        const message = JSON.parse(data.toString());
        handleCommand(ws, message);
      } else {
        // Бинарные аудио данные - пересылаем слушателям
        handleAudioData(data);
      }
    } catch (error) {
      console.error('❌ Ошибка обработки сообщения:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Подключение закрыто');
    
    // Удалить из активных стримов
    if (clientType === 'streamer' && streamId) {
      const stream = streams.get(streamId);
      if (stream) {
        // Уведомить всех слушателей что стрим закончился
        stream.listeners.forEach(listener => {
          if (listener.readyState === WebSocket.OPEN) {
            listener.send(JSON.stringify({
              type: 'stream_ended',
              streamId: streamId,
              timestamp: Date.now()
            }));
          }
        });
        streams.delete(streamId);
        console.log(`🗑️ Стрим удален: ${streamId}`);
      }
    }

    if (clientType === 'listener' && streamId) {
      const stream = streams.get(streamId);
      if (stream) {
        stream.listeners = stream.listeners.filter(l => l !== ws);
        console.log(`👂 Слушатель отключился от ${streamId}`);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket ошибка:', error);
  });

  // Обработка команд
  function handleCommand(ws, message) {
    console.log('📥 Команда:', message.type);

    switch (message.type) {
      case 'start_stream':
        // Телефон начинает стрим
        clientType = 'streamer';
        deviceId = message.deviceId;
        streamId = message.streamId || `stream_${deviceId}_${Date.now()}`;

        streams.set(streamId, {
          deviceId: deviceId,
          streamId: streamId,
          streamer: ws,
          listeners: [],
          startedAt: Date.now(),
          packetsReceived: 0,
          lastActivity: Date.now()
        });

        ws.send(JSON.stringify({
          type: 'stream_started',
          streamId: streamId,
          timestamp: Date.now()
        }));

        console.log(`✅ Стрим начат: ${streamId} от устройства ${deviceId}`);
        break;

      case 'stop_stream':
        // Телефон останавливает стрим
        if (streamId) {
          const stream = streams.get(streamId);
          if (stream) {
            // Уведомить слушателей
            stream.listeners.forEach(listener => {
              if (listener.readyState === WebSocket.OPEN) {
                listener.send(JSON.stringify({
                  type: 'stream_ended',
                  streamId: streamId,
                  timestamp: Date.now()
                }));
              }
            });
            streams.delete(streamId);
            console.log(`🛑 Стрим остановлен: ${streamId}`);
          }
        }
        break;

      case 'listen':
      case 'listen_stream':
        // Панель управления хочет слушать
        clientType = 'listener';
        deviceId = message.deviceId;
        streamId = `stream_${deviceId}_active`; // Ищем активный стрим этого устройства

        // Найти активный стрим для этого устройства
        let foundStream = null;
        for (const [sid, stream] of streams.entries()) {
          if (stream.deviceId === deviceId) {
            foundStream = stream;
            streamId = sid;
            break;
          }
        }

        if (foundStream) {
          foundStream.listeners.push(ws);
          ws.send(JSON.stringify({
            type: 'listening',
            streamId: streamId,
            deviceId: deviceId,
            timestamp: Date.now()
          }));
          console.log(`👂 Новый слушатель для ${streamId}`);
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Стрим не найден. Устройство не стримит.',
            deviceId: deviceId
          }));
          console.log(`❌ Стрим не найден для устройства ${deviceId}`);
        }
        break;

      case 'stop_listening':
        // Панель прекращает слушать
        if (streamId) {
          const stream = streams.get(streamId);
          if (stream) {
            stream.listeners = stream.listeners.filter(l => l !== ws);
            console.log(`👂 Слушатель отключился от ${streamId}`);
          }
        }
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      case 'audio_chunk':
        // Аудио данные пришли как JSON, пересылаем слушателям
        // Используем streamId из сообщения если есть
        const chunkStreamId = message.streamId || streamId;
        
        if (chunkStreamId) {
          const stream = streams.get(chunkStreamId);
          if (stream) {
            stream.packetsReceived++;
            stream.lastActivity = Date.now();
            
            let sentCount = 0;
            let skippedCount = 0;
            
            stream.listeners.forEach(listener => {
              if (listener.readyState === WebSocket.OPEN) {
                // Проверяем буфер WebSocket - если переполнен, пропускаем
                if (listener.bufferedAmount < 1024 * 100) { // 100KB буфер
                  listener.send(JSON.stringify(message));
                  sentCount++;
                } else {
                  skippedCount++;
                }
              }
            });

            if (stream.packetsReceived % 50 === 0) {
              console.log(`📊 ${chunkStreamId}: получено ${stream.packetsReceived}, отправлено ${sentCount}, пропущено ${skippedCount}`);
            }
          } else {
            console.log(`⚠️ Стрим не найден для audio_chunk: ${chunkStreamId}`);
          }
        } else {
          console.log(`⚠️ audio_chunk без streamId`);
        }
        break;

      default:
        console.log(`❓ Неизвестная команда: ${message.type}`);
    }
  }

  // Обработка аудио данных
  function handleAudioData(data) {
    if (!streamId) return;

    const stream = streams.get(streamId);
    if (!stream) return;

    stream.packetsReceived++;

    // Переслать всем слушателям
    let sentCount = 0;
    stream.listeners.forEach(listener => {
      if (listener.readyState === WebSocket.OPEN) {
        listener.send(data);
        sentCount++;
      }
    });

    if (stream.packetsReceived % 100 === 0) {
      console.log(`📊 ${streamId}: получено ${stream.packetsReceived} пакетов, отправлено ${sentCount} слушателям`);
    }
  }
});

// Периодическая очистка неактивных стримов
setInterval(() => {
  const now = Date.now();
  for (const [streamId, stream] of streams.entries()) {
    // Удалить стримы без активности более 2 минут
    const inactiveTime = now - (stream.lastActivity || stream.startedAt);
    if (inactiveTime > 2 * 60 * 1000) {
      console.log(`🗑️ Удаление неактивного стрима: ${streamId} (неактивен ${Math.floor(inactiveTime / 1000)}с)`);
      
      // Уведомить слушателей
      stream.listeners.forEach(listener => {
        if (listener.readyState === WebSocket.OPEN) {
          listener.send(JSON.stringify({
            type: 'stream_ended',
            streamId: streamId,
            reason: 'inactive',
            timestamp: Date.now()
          }));
        }
      });
      
      streams.delete(streamId);
    }
  }
}, 30000); // Каждые 30 секунд

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket сервер запущен на порту ${PORT}`);
  console.log(`📡 ws://localhost:${PORT}`);
});
