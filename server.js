const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
        
        // Хранилище данных в памяти (в продакшене используйте БД)
        this.users = new Map();
        this.chats = new Map();
        this.activeCalls = new Map();
        this.friendships = new Map(); // userId -> Set of friendIds
        this.friendRequests = new Map(); // toUserId -> Array of requests
        this.socketUsers = new Map(); // socketId -> userId
        
        // Секретный ключ для JWT
        this.JWT_SECRET = 'beresta_secret_key_change_in_production';
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
        this.createDemoData();
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static('public'));
        
        // Middleware для проверки аутентификации
        this.app.use('/api/*', (req, res, next) => {
            if (req.path.includes('/auth/')) return next();
            
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                return res.status(401).json({ error: 'Требуется авторизация' });
            }
            
            try {
                const decoded = jwt.verify(token, this.JWT_SECRET);
                req.userId = decoded.userId;
                next();
            } catch (error) {
                return res.status(401).json({ error: 'Неверный токен' });
            }
        });
    }

    setupRoutes() {
        // Основной маршрут
        this.app.get('/', (req, res) => {
            res.sendFile(__dirname + '/public/index.html');
        });

        // Регистрация
        this.app.post('/api/auth/register', async (req, res) => {
            try {
                const { name, email, password } = req.body;
                
                if (!name || !email || !password) {
                    return res.status(400).json({ error: 'Все поля обязательны' });
                }
                
                if (password.length < 6) {
                    return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
                }
                
                // Проверка email
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    return res.status(400).json({ error: 'Неверный формат email' });
                }
                
                // Проверка существования пользователя
                const existingUser = Array.from(this.users.values()).find(u => u.email === email);
                if (existingUser) {
                    return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
                }
                
                // Хэширование пароля
                const hashedPassword = await bcrypt.hash(password, 10);
                
                // Создание пользователя
                const userId = 'user_' + Date.now() + Math.random().toString(36).substr(2, 9);
                const newUser = {
                    id: userId,
                    name,
                    email,
                    password: hashedPassword,
                    avatar: name.charAt(0).toUpperCase(),
                    createdAt: new Date().toISOString(),
                    status: 'offline',
                    lastSeen: new Date().toISOString()
                };
                
                this.users.set(userId, newUser);
                this.friendships.set(userId, new Set());
                this.friendRequests.set(userId, []);
                
                // Создание токена
                const token = jwt.sign(
                    { userId: userId, email: email },
                    this.JWT_SECRET,
                    { expiresIn: '7d' }
                );
                
                // Не отправляем пароль в ответе
                const userResponse = { ...newUser };
                delete userResponse.password;
                
                // Создание демо-чата
                this.createDemoChat(userId);
                
                res.status(201).json({
                    success: true,
                    token,
                    user: userResponse
                });
                
            } catch (error) {
                console.error('Ошибка регистрации:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Вход
        this.app.post('/api/auth/login', async (req, res) => {
            try {
                const { email, password } = req.body;
                
                if (!email || !password) {
                    return res.status(400).json({ error: 'Email и пароль обязательны' });
                }
                
                // Поиск пользователя
                const usersArray = Array.from(this.users.values());
                const user = usersArray.find(u => u.email === email);
                
                if (!user) {
                    return res.status(401).json({ error: 'Неверный email или пароль' });
                }
                
                // Проверка пароля
                const validPassword = await bcrypt.compare(password, user.password);
                if (!validPassword) {
                    return res.status(401).json({ error: 'Неверный email или пароль' });
                }
                
                // Обновление статуса
                user.status = 'online';
                user.lastSeen = new Date().toISOString();
                
                // Создание токена
                const token = jwt.sign(
                    { userId: user.id, email: user.email },
                    this.JWT_SECRET,
                    { expiresIn: '7d' }
                );
                
                // Не отправляем пароль в ответе
                const userResponse = { ...user };
                delete userResponse.password;
                
                res.json({
                    success: true,
                    token,
                    user: userResponse
                });
                
            } catch (error) {
                console.error('Ошибка входа:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Получение информации о текущем пользователе
        this.app.get('/api/auth/me', (req, res) => {
            const user = this.users.get(req.userId);
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            
            const userResponse = { ...user };
            delete userResponse.password;
            
            res.json(userResponse);
        });

        // Поиск пользователей по email или имени
        this.app.get('/api/users/search', (req, res) => {
            try {
                const query = req.query.query?.toLowerCase() || '';
                const currentUserId = req.userId;
                
                if (!query || query.length < 2) {
                    return res.json([]);
                }
                
                const usersArray = Array.from(this.users.values());
                const filteredUsers = usersArray.filter(user => 
                    (user.email.toLowerCase().includes(query) || 
                     user.name.toLowerCase().includes(query)) &&
                    user.id !== currentUserId
                ).slice(0, 20); // Ограничиваем результаты
                
                // Не отправляем пароли и добавляем информацию о дружбе
                const result = filteredUsers.map(user => {
                    const { password, ...safeUser } = user;
                    const isFriend = this.friendships.get(currentUserId)?.has(user.id);
                    const hasPendingRequest = this.friendRequests.get(user.id)?.some(req => 
                        req.fromUserId === currentUserId && req.status === 'pending'
                    );
                    
                    return {
                        ...safeUser,
                        isFriend: !!isFriend,
                        hasPendingRequest: !!hasPendingRequest
                    };
                });
                
                res.json(result);
                
            } catch (error) {
                console.error('Ошибка поиска:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Получение списка друзей
        this.app.get('/api/friends', (req, res) => {
            try {
                const userId = req.userId;
                const friendIds = Array.from(this.friendships.get(userId) || []);
                
                const friends = friendIds.map(friendId => {
                    const user = this.users.get(friendId);
                    if (!user) return null;
                    
                    // Проверяем онлайн статус через сокеты
                    const isOnline = this.isUserOnline(friendId);
                    
                    return {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        avatar: user.avatar,
                        isOnline,
                        lastSeen: user.lastSeen
                    };
                }).filter(Boolean);
                
                res.json(friends);
                
            } catch (error) {
                console.error('Ошибка получения друзей:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Отправка запроса на дружбу
        this.app.post('/api/friends/request', (req, res) => {
            try {
                const { friendEmail } = req.body;
                const currentUserId = req.userId;
                
                if (!friendEmail) {
                    return res.status(400).json({ error: 'Email друга обязателен' });
                }
                
                if (friendEmail === this.users.get(currentUserId)?.email) {
                    return res.status(400).json({ error: 'Нельзя добавить самого себя в друзья' });
                }
                
                // Поиск друга
                const usersArray = Array.from(this.users.values());
                const friend = usersArray.find(u => u.email === friendEmail);
                
                if (!friend) {
                    return res.status(404).json({ error: 'Пользователь не найден' });
                }
                
                // Проверка уже существующей дружбы
                if (this.friendships.get(currentUserId)?.has(friend.id)) {
                    return res.status(400).json({ error: 'Этот пользователь уже у вас в друзьях' });
                }
                
                // Проверка существующего запроса
                const existingRequest = this.friendRequests.get(friend.id)?.find(req => 
                    req.fromUserId === currentUserId && req.status === 'pending'
                );
                
                if (existingRequest) {
                    return res.status(400).json({ error: 'Запрос уже отправлен' });
                }
                
                // Создание запроса
                const requestId = 'friend_req_' + Date.now();
                const request = {
                    id: requestId,
                    fromUserId: currentUserId,
                    toUserId: friend.id,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                };
                
                // Сохранение запроса
                if (!this.friendRequests.has(friend.id)) {
                    this.friendRequests.set(friend.id, []);
                }
                this.friendRequests.get(friend.id).push(request);
                
                // Уведомление друга через сокет
                const friendSocket = this.getSocketByUserId(friend.id);
                if (friendSocket) {
                    const fromUser = this.users.get(currentUserId);
                    friendSocket.emit('friend_request', {
                        requestId,
                        fromUser: {
                            id: fromUser.id,
                            name: fromUser.name,
                            email: fromUser.email,
                            avatar: fromUser.avatar
                        },
                        createdAt: request.createdAt
                    });
                }
                
                res.json({
                    success: true,
                    message: 'Запрос на дружбу отправлен',
                    requestId
                });
                
            } catch (error) {
                console.error('Ошибка отправки запроса:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Получение входящих запросов в друзья
        this.app.get('/api/friends/requests', (req, res) => {
            try {
                const userId = req.userId;
                const requests = this.friendRequests.get(userId) || [];
                
                // Фильтруем только pending запросы
                const pendingRequests = requests.filter(req => req.status === 'pending');
                
                // Добавляем информацию о пользователях
                const detailedRequests = pendingRequests.map(req => {
                    const fromUser = this.users.get(req.fromUserId);
                    return {
                        id: req.id,
                        fromUser: fromUser ? {
                            id: fromUser.id,
                            name: fromUser.name,
                            email: fromUser.email,
                            avatar: fromUser.avatar
                        } : null,
                        createdAt: req.createdAt
                    };
                }).filter(req => req.fromUser);
                
                res.json(detailedRequests);
                
            } catch (error) {
                console.error('Ошибка получения запросов:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Принятие запроса на дружбу
        this.app.post('/api/friends/requests/:requestId/accept', (req, res) => {
            try {
                const { requestId } = req.params;
                const userId = req.userId;
                
                const requests = this.friendRequests.get(userId) || [];
                const requestIndex = requests.findIndex(req => req.id === requestId && req.status === 'pending');
                
                if (requestIndex === -1) {
                    return res.status(404).json({ error: 'Запрос не найден' });
                }
                
                const request = requests[requestIndex];
                
                // Обновление статуса запроса
                request.status = 'accepted';
                request.respondedAt = new Date().toISOString();
                
                // Добавление в друзья
                if (!this.friendships.has(userId)) this.friendships.set(userId, new Set());
                if (!this.friendships.has(request.fromUserId)) this.friendships.set(request.fromUserId, new Set());
                
                this.friendships.get(userId).add(request.fromUserId);
                this.friendships.get(request.fromUserId).add(userId);
                
                // Уведомление отправителя
                const fromUserSocket = this.getSocketByUserId(request.fromUserId);
                if (fromUserSocket) {
                    const currentUser = this.users.get(userId);
                    fromUserSocket.emit('friend_request_accepted', {
                        byUser: {
                            id: currentUser.id,
                            name: currentUser.name,
                            email: currentUser.email,
                            avatar: currentUser.avatar
                        }
                    });
                }
                
                // Автоматически создаем чат
                this.createChatBetweenUsers(userId, request.fromUserId);
                
                res.json({
                    success: true,
                    message: 'Запрос принят',
                    friendId: request.fromUserId
                });
                
            } catch (error) {
                console.error('Ошибка принятия запроса:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Отклонение запроса на дружбу
        this.app.post('/api/friends/requests/:requestId/reject', (req, res) => {
            try {
                const { requestId } = req.params;
                const userId = req.userId;
                
                const requests = this.friendRequests.get(userId) || [];
                const requestIndex = requests.findIndex(req => req.id === requestId && req.status === 'pending');
                
                if (requestIndex === -1) {
                    return res.status(404).json({ error: 'Запрос не найден' });
                }
                
                const request = requests[requestIndex];
                request.status = 'rejected';
                request.respondedAt = new Date().toISOString();
                
                res.json({
                    success: true,
                    message: 'Запрос отклонен'
                });
                
            } catch (error) {
                console.error('Ошибка отклонения запроса:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Удаление друга
        this.app.delete('/api/friends/:friendId', (req, res) => {
            try {
                const { friendId } = req.params;
                const userId = req.userId;
                
                // Удаление из списков друзей
                if (this.friendships.has(userId)) {
                    this.friendships.get(userId).delete(friendId);
                }
                
                if (this.friendships.has(friendId)) {
                    this.friendships.get(friendId).delete(userId);
                }
                
                // Удаление связанных чатов (можно оставить историю)
                // this.removeChatBetweenUsers(userId, friendId);
                
                res.json({
                    success: true,
                    message: 'Пользователь удален из друзей'
                });
                
            } catch (error) {
                console.error('Ошибка удаления друга:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // API для чатов
        this.app.get('/api/chats', (req, res) => {
            try {
                const userId = req.userId;
                const userChats = Array.from(this.chats.values())
                    .filter(chat => chat.participants.includes(userId))
                    .map(chat => ({
                        id: chat.id,
                        name: chat.name,
                        type: chat.type,
                        participants: chat.participants.map(pId => {
                            const user = this.users.get(pId);
                            return user ? {
                                id: user.id,
                                name: user.name,
                                avatar: user.avatar
                            } : null;
                        }).filter(Boolean),
                        lastMessage: chat.messages[chat.messages.length - 1] || null,
                        unreadCount: chat.unreadCount || 0,
                        createdAt: chat.createdAt,
                        updatedAt: chat.updatedAt
                    }));
                
                res.json(userChats);
                
            } catch (error) {
                console.error('Ошибка получения чатов:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        this.app.post('/api/chats', (req, res) => {
            try {
                const { name, participantIds } = req.body;
                const userId = req.userId;
                
                if (!participantIds || !Array.isArray(participantIds)) {
                    return res.status(400).json({ error: 'Участники обязательны' });
                }
                
                // Все участники должны существовать
                const allParticipants = [...new Set([userId, ...participantIds])];
                for (const pId of allParticipants) {
                    if (!this.users.has(pId)) {
                        return res.status(404).json({ error: `Пользователь ${pId} не найден` });
                    }
                }
                
                // Проверяем существующий чат
                const existingChat = Array.from(this.chats.values()).find(chat => 
                    chat.participants.length === allParticipants.length &&
                    chat.participants.every(pId => allParticipants.includes(pId))
                );
                
                if (existingChat) {
                    return res.status(400).json({ error: 'Чат уже существует' });
                }
                
                // Создаем чат
                const chatId = 'chat_' + Date.now();
                const chatName = name || allParticipants
                    .filter(pId => pId !== userId)
                    .map(pId => this.users.get(pId)?.name)
                    .join(', ');
                
                const newChat = {
                    id: chatId,
                    name: chatName,
                    type: allParticipants.length > 2 ? 'group' : 'private',
                    participants: allParticipants,
                    messages: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                
                this.chats.set(chatId, newChat);
                
                // Уведомляем участников
                allParticipants.forEach(pId => {
                    const userSocket = this.getSocketByUserId(pId);
                    if (userSocket) {
                        userSocket.emit('chat_created', newChat);
                    }
                });
                
                res.status(201).json(newChat);
                
            } catch (error) {
                console.error('Ошибка создания чата:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        this.app.get('/api/chats/:chatId/messages', (req, res) => {
            try {
                const { chatId } = req.params;
                const userId = req.userId;
                
                const chat = this.chats.get(chatId);
                if (!chat) {
                    return res.status(404).json({ error: 'Чат не найден' });
                }
                
                if (!chat.participants.includes(userId)) {
                    return res.status(403).json({ error: 'Нет доступа к чату' });
                }
                
                // Сбрасываем счетчик непрочитанных
                chat.unreadCount = 0;
                
                res.json(chat.messages.slice(-100)); // Последние 100 сообщений
                
            } catch (error) {
                console.error('Ошибка получения сообщений:', error);
                res.status(500).json({ error: 'Ошибка сервера' });
            }
        });

        // Проверка здоровья
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                users: this.users.size,
                chats: this.chats.size,
                activeCalls: this.activeCalls.size,
                uptime: process.uptime()
            });
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log('Новое подключение:', socket.id);

            // Аутентификация через сокет
            socket.on('authenticate', (token) => {
                try {
                    const decoded = jwt.verify(token, this.JWT_SECRET);
                    const userId = decoded.userId;
                    
                    if (this.users.has(userId)) {
                        socket.userId = userId;
                        this.socketUsers.set(socket.id, userId);
                        
                        // Обновляем статус пользователя
                        const user = this.users.get(userId);
                        user.status = 'online';
                        user.lastSeen = new Date().toISOString();
                        
                        // Уведомляем друзей
                        this.notifyFriendsStatusChange(userId, 'online');
                        
                        console.log(`Пользователь ${user.name} аутентифицирован через сокет`);
                        
                        socket.emit('authenticated', { success: true });
                        
                        // Отправляем обновленные данные
                        this.sendUserDataToSocket(userId, socket);
                    }
                } catch (error) {
                    socket.emit('auth_error', { error: 'Неверный токен' });
                }
            });

            // Отправка сообщения
            socket.on('send_message', (messageData) => {
                const { chatId, text } = messageData;
                const userId = socket.userId;
                
                if (!userId || !chatId || !text) return;
                
                const chat = this.chats.get(chatId);
                if (!chat || !chat.participants.includes(userId)) return;
                
                const user = this.users.get(userId);
                if (!user) return;
                
                const message = {
                    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                    text,
                    senderId: userId,
                    senderName: user.name,
                    senderAvatar: user.avatar,
                    timestamp: new Date().toISOString(),
                    chatId
                };
                
                chat.messages.push(message);
                chat.updatedAt = new Date().toISOString();
                chat.lastMessage = message;
                
                // Ограничиваем историю сообщений
                if (chat.messages.length > 1000) {
                    chat.messages = chat.messages.slice(-100);
                }
                
                // Отправляем сообщение всем участникам чата
                chat.participants.forEach(participantId => {
                    const participantSocket = this.getSocketByUserId(participantId);
                    if (participantSocket) {
                        participantSocket.emit('new_message', {
                            chatId,
                            message
                        });
                    } else {
                        // Увеличиваем счетчик непрочитанных для офлайн пользователей
                        if (participantId !== userId) {
                            chat.unreadCount = (chat.unreadCount || 0) + 1;
                        }
                    }
                });
            });

            // Начало звонка
            socket.on('start_call', (data) => {
                const { chatId, type } = data;
                const userId = socket.userId;
                
                if (!userId || !chatId) return;
                
                const chat = this.chats.get(chatId);
                if (!chat || !chat.participants.includes(userId)) return;
                
                const user = this.users.get(userId);
                if (!user) return;
                
                // Создаем данные звонка
                const callId = 'call_' + Date.now();
                const callData = {
                    id: callId,
                    chatId,
                    callerId: userId,
                    callerName: user.name,
                    type: type || 'voice',
                    participants: [userId],
                    status: 'calling',
                    startTime: new Date().toISOString()
                };
                
                this.activeCalls.set(callId, callData);
                
                // Уведомляем других участников чата
                chat.participants.forEach(participantId => {
                    if (participantId !== userId) {
                        const participantSocket = this.getSocketByUserId(participantId);
                        if (participantSocket) {
                            participantSocket.emit('incoming_call', {
                                callId,
                                chatId,
                                caller: user.name,
                                type: callData.type
                            });
                        }
                    }
                });
                
                // Отправляем данные звонка звонящему
                socket.emit('call_started', {
                    callId,
                    callData
                });
            });

            // Принятие звонка
            socket.on('accept_call', (data) => {
                const { callId } = data;
                const userId = socket.userId;
                
                if (!userId || !callId) return;
                
                const callData = this.activeCalls.get(callId);
                if (!callData) return;
                
                callData.participants.push(userId);
                callData.status = 'active';
                
                // Уведомляем всех участников о принятии звонка
                this.io.emit('call_accepted', {
                    callId,
                    userId,
                    callData
                });
            });

            // Завершение звонка
            socket.on('end_call', (data) => {
                const { callId } = data;
                const userId = socket.userId;
                
                if (!callId) return;
                
                const callData = this.activeCalls.get(callId);
                if (!callData) return;
                
                // Уведомляем всех участников о завершении звонка
                callData.participants.forEach(participantId => {
                    const participantSocket = this.getSocketByUserId(participantId);
                    if (participantSocket) {
                        participantSocket.emit('call_ended', {
                            callId,
                            duration: Math.floor((new Date() - new Date(callData.startTime)) / 1000)
                        });
                    }
                });
                
                this.activeCalls.delete(callId);
            });

            // Отключение пользователя
            socket.on('disconnect', () => {
                const userId = this.socketUsers.get(socket.id);
                if (userId) {
                    this.socketUsers.delete(socket.id);
                    
                    // Обновляем статус пользователя
                    const user = this.users.get(userId);
                    if (user) {
                        user.status = 'offline';
                        user.lastSeen = new Date().toISOString();
                        
                        // Уведомляем друзей
                        this.notifyFriendsStatusChange(userId, 'offline');
                        
                        console.log(`Пользователь ${user.name} отключился`);
                    }
                }
            });
        });
    }

    // Вспомогательные методы
    createDemoData() {
        // Создаем демо пользователей если их нет
        if (this.users.size === 0) {
            const demoUsers = [
                {
                    id: 'demo_user_1',
                    name: 'Анна Иванова',
                    email: 'anna@example.com',
                    password: '$2a$10$abc123', // В реальности хэш
                    avatar: 'А',
                    status: 'online',
                    createdAt: new Date().toISOString(),
                    lastSeen: new Date().toISOString()
                },
                {
                    id: 'demo_user_2',
                    name: 'Иван Петров',
                    email: 'ivan@example.com',
                    password: '$2a$10$def456',
                    avatar: 'И',
                    status: 'offline',
                    createdAt: new Date().toISOString(),
                    lastSeen: new Date(Date.now() - 3600000).toISOString() // Был онлайн час назад
                },
                {
                    id: 'demo_user_3',
                    name: 'Мария Сидорова',
                    email: 'maria@example.com',
                    password: '$2a$10$ghi789',
                    avatar: 'М',
                    status: 'online',
                    createdAt: new Date().toISOString(),
                    lastSeen: new Date().toISOString()
                }
            ];
            
            demoUsers.forEach(user => {
                this.users.set(user.id, user);
                this.friendships.set(user.id, new Set());
                this.friendRequests.set(user.id, []);
            });
            
            // Создаем демо дружбы
            this.friendships.get('demo_user_1').add('demo_user_2');
            this.friendships.get('demo_user_2').add('demo_user_1');
            this.friendships.get('demo_user_1').add('demo_user_3');
            this.friendships.get('demo_user_3').add('demo_user_1');
            
            // Создаем демо чаты
            this.createDemoChat('demo_user_1');
        }
    }

    createDemoChat(userId) {
        const chatId = 'demo_chat_' + userId;
        if (!this.chats.has(chatId)) {
            const chat = {
                id: chatId,
                name: 'Общий чат',
                type: 'group',
                participants: ['demo_user_1', 'demo_user_2', 'demo_user_3', userId].filter((v, i, a) => a.indexOf(v) === i),
                messages: [
                    {
                        id: 'demo_msg_1',
                        text: 'Добро пожаловать в Береста! 🎉',
                        senderId: 'demo_user_1',
                        senderName: 'Анна Иванова',
                        senderAvatar: 'А',
                        timestamp: new Date(Date.now() - 86400000).toISOString(), // Вчера
                        chatId
                    },
                    {
                        id: 'demo_msg_2',
                        text: 'Здесь вы можете общаться с друзьями, совершать звонки и многое другое!',
                        senderId: 'demo_user_2',
                        senderName: 'Иван Петров',
                        senderAvatar: 'И',
                        timestamp: new Date(Date.now() - 43200000).toISOString(), // 12 часов назад
                        chatId
                    },
                    {
                        id: 'demo_msg_3',
                        text: 'Добавляйте друзей по email и начинайте новые беседы! 👋',
                        senderId: 'demo_user_3',
                        senderName: 'Мария Сидорова',
                        senderAvatar: 'М',
                        timestamp: new Date().toISOString(),
                        chatId
                    }
                ],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastMessage: null
            };
            
            chat.lastMessage = chat.messages[chat.messages.length - 1];
            this.chats.set(chatId, chat);
        }
    }

    createChatBetweenUsers(userId1, userId2) {
        const chatId = `chat_${userId1}_${userId2}`;
        const reverseChatId = `chat_${userId2}_${userId1}`;
        
        // Проверяем существующий чат
        const existingChat = this.chats.get(chatId) || this.chats.get(reverseChatId);
        if (existingChat) return existingChat.id;
        
        const user1 = this.users.get(userId1);
        const user2 = this.users.get(userId2);
        
        if (!user1 || !user2) return null;
        
        const newChat = {
            id: chatId,
            name: user2.name,
            type: 'private',
            participants: [userId1, userId2],
            messages: [
                {
                    id: 'welcome_msg',
                    text: `Привет! Я ${user1.name}. Давайте общаться! 😊`,
                    senderId: userId1,
                    senderName: user1.name,
                    senderAvatar: user1.avatar,
                    timestamp: new Date().toISOString(),
                    chatId
                }
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastMessage: null
        };
        
        newChat.lastMessage = newChat.messages[newChat.messages.length - 1];
        this.chats.set(chatId, newChat);
        
        return chatId;
    }

    getSocketByUserId(userId) {
        for (const [socketId, uid] of this.socketUsers.entries()) {
            if (uid === userId) {
                return this.io.sockets.sockets.get(socketId);
            }
        }
        return null;
    }

    isUserOnline(userId) {
        return Array.from(this.socketUsers.values()).includes(userId);
    }

    notifyFriendsStatusChange(userId, status) {
        const user = this.users.get(userId);
        if (!user) return;
        
        const friendIds = Array.from(this.friendships.get(userId) || []);
        friendIds.forEach(friendId => {
            const friendSocket = this.getSocketByUserId(friendId);
            if (friendSocket) {
                friendSocket.emit('friend_status_changed', {
                    friendId: userId,
                    name: user.name,
                    status,
                    lastSeen: user.lastSeen
                });
            }
        });
    }

    sendUserDataToSocket(userId, socket) {
        const user = this.users.get(userId);
        if (!user) return;
        
        // Отправляем список друзей
        const friendIds = Array.from(this.friendships.get(userId) || []);
        const friends = friendIds.map(friendId => {
            const friend = this.users.get(friendId);
            if (!friend) return null;
            
            return {
                id: friend.id,
                name: friend.name,
                email: friend.email,
                avatar: friend.avatar,
                isOnline: this.isUserOnline(friendId),
                lastSeen: friend.lastSeen
            };
        }).filter(Boolean);
        
        socket.emit('friends_list', friends);
        
        // Отправляем входящие запросы
        const requests = this.friendRequests.get(userId) || [];
        const pendingRequests = requests.filter(req => req.status === 'pending');
        const detailedRequests = pendingRequests.map(req => {
            const fromUser = this.users.get(req.fromUserId);
            return fromUser ? {
                id: req.id,
                fromUser: {
                    id: fromUser.id,
                    name: fromUser.name,
                    email: fromUser.email,
                    avatar: fromUser.avatar
                },
                createdAt: req.createdAt
            } : null;
        }).filter(Boolean);
        
        socket.emit('friend_requests', detailedRequests);
        
        // Отправляем список чатов
        const userChats = Array.from(this.chats.values())
            .filter(chat => chat.participants.includes(userId))
            .map(chat => ({
                id: chat.id,
                name: chat.name,
                type: chat.type,
                participants: chat.participants.map(pId => {
                    const user = this.users.get(pId);
                    return user ? {
                        id: user.id,
                        name: user.name,
                        avatar: user.avatar
                    } : null;
                }).filter(Boolean),
                lastMessage: chat.lastMessage,
                unreadCount: chat.unreadCount || 0,
                createdAt: chat.createdAt,
                updatedAt: chat.updatedAt
            }));
        
        socket.emit('chats_list', userChats);
    }

    start(port = process.env.PORT || 3000) {
        this.server.listen(port, () => {
            console.log(`
╔═══════════════════════════════════════╗
║    🌳 Мессенджер Береста запущен     ║
║    Порт: ${port}                            ║
║    Демо пользователи:                 ║
║    1. anna@example.com / test123     ║
║    2. ivan@example.com / test123     ║
║    3. maria@example.com / test123    ║
╚═══════════════════════════════════════╝
            `);
        });
    }
}

// Запуск сервера
const server = new BerezaServer();
server.start();
