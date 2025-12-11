const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

class BerezaServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        
        this.users = new Map(); // Map<socketId, user>
        this.chats = new Map(); // Map<chatId, chat>
        this.activeCalls = new Map(); // Map<chatId, callData>
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static('public'));
    }

    setupRoutes() {
        // Основной маршрут
        this.app.get('/', (req, res) => {
            res.sendFile(__dirname + '/index.html');
        });

        // API для получения списка чатов
        this.app.get('/api/chats/:userId', (req, res) => {
            const userId = req.params.userId;
            const userChats = Array.from(this.chats.values())
                .filter(chat => chat.participants.includes(userId))
                .map(chat => ({
                    id: chat.id,
                    name: chat.name,
                    lastMessage: chat.messages[chat.messages.length - 1]?.text || null,
                    participants: chat.participants,
                    createdAt: chat.createdAt
                }));
            
            res.json(userChats);
        });

        // API для создания чата
        this.app.post('/api/chats', (req, res) => {
            const { name, participants } = req.body;
            
            if (!name || !participants) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const chatId = 'chat_' + Date.now();
            const newChat = {
                id: chatId,
                name,
                participants,
                messages: [],
                createdAt: new Date().toISOString()
            };

            this.chats.set(chatId, newChat);
            res.status(201).json(newChat);
        });

        // API для отправки сообщения
        this.app.post('/api/messages', (req, res) => {
            const { chatId, text, senderId, senderName } = req.body;
            
            if (!chatId || !text || !senderId) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const chat = this.chats.get(chatId);
            if (!chat) {
                return res.status(404).json({ error: 'Chat not found' });
            }

            const message = {
                id: 'msg_' + Date.now(),
                text,
                senderId,
                senderName,
                timestamp: new Date().toISOString(),
                chatId
            };

            chat.messages.push(message);
            
            // Ограничиваем историю сообщений
            if (chat.messages.length > 1000) {
                chat.messages = chat.messages.slice(-1000);
            }

            // Уведомляем участников чата о новом сообщении
            const participants = chat.participants;
            participants.forEach(userId => {
                const userSocket = this.getSocketByUserId(userId);
                if (userSocket) {
                    userSocket.emit('new_message', {
                        chatId,
                        message
                    });
                }
            });

            res.status(201).json(message);
        });

        // API для получения сообщений чата
        this.app.get('/api/messages/:chatId', (req, res) => {
            const chatId = req.params.chatId;
            const chat = this.chats.get(chatId);
            
            if (!chat) {
                return res.status(404).json({ error: 'Chat not found' });
            }

            res.json(chat.messages);
        });

        // Проверка здоровья сервера
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                users: this.users.size,
                chats: this.chats.size,
                activeCalls: this.activeCalls.size 
            });
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log('Новое подключение:', socket.id);

            // Подключение пользователя
            socket.on('user_connected', (userData) => {
                const user = {
                    id: userData.id || 'user_' + Date.now(),
                    name: userData.name || 'User',
                    avatar: userData.avatar || 'U',
                    socketId: socket.id
                };
                
                this.users.set(user.id, user);
                socket.userId = user.id;
                
                console.log(`Пользователь ${user.name} подключен`);
                
                // Отправляем список чатов пользователю
                this.sendChatsToUser(user.id);
            });

            // Получение списка чатов
            socket.on('get_chats', (userId) => {
                this.sendChatsToUser(userId);
            });

            // Создание нового чата
            socket.on('create_chat', (chatData) => {
                const chatId = chatData.id || 'chat_' + Date.now();
                const newChat = {
                    id: chatId,
                    name: chatData.name,
                    participants: chatData.participants || [socket.userId],
                    messages: [],
                    createdAt: new Date().toISOString()
                };

                this.chats.set(chatId, newChat);
                
                // Уведомляем участников о создании чата
                newChat.participants.forEach(userId => {
                    const userSocket = this.getSocketByUserId(userId);
                    if (userSocket) {
                        userSocket.emit('chat_created', newChat);
                    }
                });
            });

            // Отправка сообщения
            socket.on('send_message', (message) => {
                const chat = this.chats.get(message.chatId);
                if (!chat) {
                    console.log('Чат не найден:', message.chatId);
                    return;
                }

                // Добавляем сообщение в историю
                chat.messages.push(message);
                
                // Ограничиваем историю сообщений
                if (chat.messages.length > 1000) {
                    chat.messages = chat.messages.slice(-1000);
                }

                // Обновляем последнее сообщение в чате
                chat.lastMessage = message.text;

                // Отправляем сообщение всем участникам чата
                chat.participants.forEach(userId => {
                    const userSocket = this.getSocketByUserId(userId);
                    if (userSocket && userId !== message.senderId) {
                        userSocket.emit('new_message', {
                            chatId: message.chatId,
                            message: message
                        });
                    }
                });
            });

            // Начало звонка
            socket.on('start_call', (data) => {
                const { chatId, caller, type } = data;
                const chat = this.chats.get(chatId);
                
                if (!chat) {
                    console.log('Чат не найден для звонка:', chatId);
                    return;
                }

                // Сохраняем информацию о звонке
                const callData = {
                    chatId,
                    caller: caller || 'Unknown',
                    type: type || 'voice',
                    status: 'calling',
                    participants: chat.participants,
                    startTime: new Date().toISOString()
                };
                
                this.activeCalls.set(chatId, callData);

                // Отправляем уведомление о звонке другим участникам
                chat.participants.forEach(userId => {
                    const userSocket = this.getSocketByUserId(userId);
                    if (userSocket && userId !== socket.userId) {
                        userSocket.emit('incoming_call', {
                            chatId,
                            caller: caller,
                            type: type
                        });
                    }
                });
            });

            // Принятие звонка
            socket.on('accept_call', (data) => {
                const { chatId } = data;
                const callData = this.activeCalls.get(chatId);
                
                if (!callData) {
                    console.log('Звонок не найден:', chatId);
                    return;
                }

                callData.status = 'active';
                
                // Уведомляем всех участников о принятии звонка
                callData.participants.forEach(userId => {
                    const userSocket = this.getSocketByUserId(userId);
                    if (userSocket) {
                        userSocket.emit('call_accepted', {
                            chatId,
                            caller: callData.caller
                        });
                    }
                });
            });

            // Отклонение звонка
            socket.on('reject_call', (data) => {
                const { chatId } = data;
                const callData = this.activeCalls.get(chatId);
                
                if (!callData) return;

                // Уведомляем всех участников об отклонении звонка
                callData.participants.forEach(userId => {
                    const userSocket = this.getSocketByUserId(userId);
                    if (userSocket) {
                        userSocket.emit('call_rejected', {
                            chatId,
                            caller: callData.caller
                        });
                    }
                });

                this.activeCalls.delete(chatId);
            });

            // Завершение звонка
            socket.on('end_call', (data) => {
                const { chatId } = data;
                const callData = this.activeCalls.get(chatId);
                
                if (!callData) return;

                // Уведомляем всех участников о завершении звонка
                callData.participants.forEach(userId => {
                    const userSocket = this.getSocketByUserId(userId);
                    if (userSocket) {
                        userSocket.emit('call_ended', {
                            chatId,
                            duration: Math.floor((new Date() - new Date(callData.startTime)) / 1000)
                        });
                    }
                });

                this.activeCalls.delete(chatId);
            });

            // Отключение пользователя
            socket.on('disconnect', () => {
                if (socket.userId) {
                    const user = this.users.get(socket.userId);
                    if (user) {
                        console.log(`Пользователь ${user.name} отключился`);
                        this.users.delete(socket.userId);
                    }
                }
            });
        });
    }

    sendChatsToUser(userId) {
        const userSocket = this.getSocketByUserId(userId);
        if (!userSocket) return;

        const userChats = Array.from(this.chats.values())
            .filter(chat => chat.participants.includes(userId))
            .map(chat => ({
                id: chat.id,
                name: chat.name,
                lastMessage: chat.messages.length > 0 
                    ? chat.messages[chat.messages.length - 1].text 
                    : 'Нет сообщений',
                participants: chat.participants,
                messageCount: chat.messages.length,
                createdAt: chat.createdAt
            }));

        userSocket.emit('chats_list', userChats);
    }

    getSocketByUserId(userId) {
        const user = this.users.get(userId);
        if (!user) return null;
        
        return this.io.sockets.sockets.get(user.socketId);
    }

    start(port = process.env.PORT || 3000) {
        this.server.listen(port, () => {
            console.log(`Сервер Береста запущен на порту ${port}`);
            console.log(`Доступен по адресу: http://localhost:${port}`);
        });
    }
}

// Запуск сервера
const server = new BerezaServer();
server.start();
