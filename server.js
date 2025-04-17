const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://photon-xz0s.onrender.com";

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/profile-photos', express.static(path.join(__dirname, 'profile-photos')));

const usersDB = path.join(__dirname, 'users.json');
const messagesDB = path.join(__dirname, 'messages.json');
const textMessagesDB = path.join(__dirname, 'text_messages.json');
const adminDB = path.join(__dirname, 'admins.json');

// Initialize database files if they don't exist
if (!fs.existsSync(usersDB)) fs.writeFileSync(usersDB, JSON.stringify({}));
if (!fs.existsSync(messagesDB)) fs.writeFileSync(messagesDB, JSON.stringify([]));
if (!fs.existsSync(textMessagesDB)) fs.writeFileSync(textMessagesDB, JSON.stringify([]));
if (!fs.existsSync(adminDB)) fs.writeFileSync(adminDB, JSON.stringify(["admin"])); // Default admin

// Ensure required directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const profilePhotosDir = path.join(__dirname, 'profile-photos');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(profilePhotosDir)) fs.mkdirSync(profilePhotosDir);

// Database helpers
const getUsers = () => JSON.parse(fs.readFileSync(usersDB, 'utf8'));
const saveUsers = (users) => fs.writeFileSync(usersDB, JSON.stringify(users, null, 2));
const getMessages = () => JSON.parse(fs.readFileSync(messagesDB, 'utf8'));
const saveMessages = (msgs) => fs.writeFileSync(messagesDB, JSON.stringify(msgs, null, 2));
const getTextMessages = () => JSON.parse(fs.readFileSync(textMessagesDB, 'utf8'));
const saveTextMessages = (msgs) => fs.writeFileSync(textMessagesDB, JSON.stringify(msgs, null, 2));
const getAdmins = () => JSON.parse(fs.readFileSync(adminDB, 'utf8'));

// Configure multer for file uploads
const storageImage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const storageProfile = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'profile-photos/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storageImage });
const uploadProfile = multer({ storage: storageProfile });

// Socket connections maps
let sockets = {}; // userId -> socketId
let adminSockets = []; // Array of admin socket IDs
let typing = {}; // userId -> {to: recipientId, text: currentText}
let typingTimeouts = {}; // userId -> timeout

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Regular user registration
  socket.on('register', (userId) => {
    sockets[userId] = socket.id;
    console.log(`Registered user ${userId} with socket ${socket.id}`);
    
    // Notify admins about online users
    emitOnlineUsers();
  });
  
  // Admin registration
  socket.on('register-admin', () => {
    console.log(`Registered admin with socket ${socket.id}`);
    adminSockets.push(socket.id);
    
    // Send current online users to the admin
    socket.emit('online-users', Object.keys(sockets));
  });

  // Live typing event
  socket.on('typing', (data) => {
    if (!data.from || !data.to || !data.text) return;
    
    // Save typing state
    typing[data.from] = { to: data.to, text: data.text };
    
    // Clear previous timeout if exists
    if (typingTimeouts[data.from]) {
      clearTimeout(typingTimeouts[data.from]);
    }
    
    // Set timeout to clear typing state after 2 seconds of inactivity
    typingTimeouts[data.from] = setTimeout(() => {
      delete typing[data.from];
    }, 2000);
    
    // Forward typing event to recipient
    if (sockets[data.to]) {
      io.to(sockets[data.to]).emit('typing', data);
    }
    
    // Forward to admins
    adminSockets.forEach(socketId => {
      io.to(socketId).emit('typing', data);
    });
  });
  
  // Read receipt event
  socket.on('read-receipt', (data) => {
    if (!data.messageId || !data.userId) return;
    
    // Update the message as read in database
    const messages = getTextMessages();
    const messageIndex = messages.findIndex(m => m.id === data.messageId);
    
    if (messageIndex !== -1) {
      messages[messageIndex].readAt = Date.now();
      saveTextMessages(messages);
      
      // Notify sender
      const senderId = messages[messageIndex].from;
      if (sockets[senderId]) {
        io.to(sockets[senderId]).emit('read-receipt', data);
      }
      
      // Notify admins
      adminSockets.forEach(socketId => {
        io.to(socketId).emit('read-receipt', data);
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Check if it was a user
    for (let uid in sockets) {
      if (sockets[uid] === socket.id) {
        delete sockets[uid];
        
        // Also delete from typing if they were typing
        if (typing[uid]) {
          delete typing[uid];
          if (typingTimeouts[uid]) {
            clearTimeout(typingTimeouts[uid]);
            delete typingTimeouts[uid];
          }
        }
        
        // Notify admins about online users
        emitOnlineUsers();
        break;
      }
    }
    
    // Check if it was an admin
    const adminIndex = adminSockets.indexOf(socket.id);
    if (adminIndex !== -1) {
      adminSockets.splice(adminIndex, 1);
    }
  });
});

// Helper function to emit online users to all admins
function emitOnlineUsers() {
  const onlineUsers = Object.keys(sockets);
  adminSockets.forEach(socketId => {
    io.to(socketId).emit('online-users', onlineUsers);
  });
}

// User registration with password and profile picture
app.post('/register', uploadProfile.single('profilePhoto'), (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password || !req.file) return res.status(400).json({ error: 'Missing userId, password, or profilePhoto' });

  const users = getUsers();
  if (users[userId]) {
    return res.status(400).json({ error: 'User already exists' });
  }

  users[userId] = {
    userId,
    password,
    profilePhoto: req.file.filename,
    createdAt: Date.now()
  };

  saveUsers(users);
  res.json({ message: 'User registered successfully', profilePhoto: req.file.filename });
});

// Login with password
app.post('/login', (req, res) => {
  const { userId, password } = req.body;
  const users = getUsers();
  const user = users[userId];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ message: 'Login successful', profilePhoto: user.profilePhoto });
});

// Admin login with password
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  // In a real application, you would have more secure admin authentication
  // For simplicity, we're using a basic static check
  if (username === 'admin' && password === 'admin123') {
    res.json({ message: 'Admin login successful' });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

// Get all users (for favorites selection)
app.get('/users', (req, res) => {
  const users = getUsers();
  const sanitized = Object.values(users).map(({ userId, profilePhoto }) => ({ userId, profilePhoto }));
  res.json(sanitized);
});

// Get online users
app.get('/online-users', (req, res) => {
  res.json(Object.keys(sockets));
});

// Get all images
app.get('/images', (req, res) => {
  res.json(getMessages());
});

// Send image
app.post('/send-image', upload.single('file'), (req, res) => {
  try {
    const { userIDFrom, userIDTo } = req.body;
    const filename = req.file.filename;
    const url = `${BASE_URL}/uploads/${filename}`;

    const msg = {
      id: Date.now().toString(),
      from: userIDFrom,
      to: userIDTo,
      url,
      filename,
      timestamp: Date.now()
    };

    const messages = getMessages();
    messages.push(msg);
    saveMessages(messages);

    // Send to recipient
    if (sockets[userIDTo]) {
      io.to(sockets[userIDTo]).emit('image', msg);
    }
    
    // Send to admins
    adminSockets.forEach(socketId => {
      io.to(socketId).emit('image', msg);
    });

    res.json({ message: 'Image sent', to: userIDTo, url });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Send text message
app.post('/send-message', (req, res) => {
  try {
    const { from, to, text } = req.body;
    if (!from || !to || !text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const msg = {
      id: Date.now().toString(),
      from,
      to,
      text,
      timestamp: Date.now(),
      readAt: null,
      delivered: true
    };

    const messages = getTextMessages();
    messages.push(msg);
    saveTextMessages(messages);

    // Clear typing indicator as the message is now sent
    if (typing[from] && typing[from].to === to) {
      delete typing[from];
      if (typingTimeouts[from]) {
        clearTimeout(typingTimeouts[from]);
        delete typingTimeouts[from];
      }
    }

    // Send to recipient
    if (sockets[to]) {
      io.to(sockets[to]).emit('message', msg);
    }
    
    // Send to admins
    adminSockets.forEach(socketId => {
      io.to(socketId).emit('message', msg);
    });

    res.json({ message: 'Message sent', id: msg.id });
  } catch (error) {
    console.error("Message send error:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Get message history for two users
app.get('/message-history', (req, res) => {
  try {
    const { userId, otherId } = req.query;
    if (!userId || !otherId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const messages = getTextMessages().filter(msg => 
      (msg.from === userId && msg.to === otherId) || 
      (msg.from === otherId && msg.to === userId)
    ).sort((a, b) => a.timestamp - b.timestamp);

    res.json(messages);
  } catch (error) {
    console.error("Message history error:", error);
    res.status(500).json({ error: "Failed to retrieve message history" });
  }
});

// Delete user
app.delete('/delete-user/:userId', (req, res) => {
  const userId = req.params.userId;
  const users = getUsers();
  if (!users[userId]) return res.status(404).json({ error: 'User not found' });

  const profilePic = users[userId].profilePhoto;
  const profilePath = path.join(__dirname, 'profile-photos', profilePic);
  if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);

  delete users[userId];
  saveUsers(users);

  const messages = getMessages().filter(m => m.from !== userId && m.to !== userId);
  saveMessages(messages);
  
  const textMessages = getTextMessages().filter(m => m.from !== userId && m.to !== userId);
  saveTextMessages(textMessages);

  res.json({ message: 'User deleted' });
});

// Delete image
app.delete('/delete-image/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const messages = getMessages().filter(m => m.filename !== filename);
  saveMessages(messages);

  res.json({ message: 'Image deleted' });
});

// ADMIN API ENDPOINTS

// Get dashboard stats
app.get('/admin/stats', (req, res) => {
  const users = getUsers();
  const textMessages = getTextMessages();
  const imageMessages = getMessages();
  
  const stats = {
    totalUsers: Object.keys(users).length,
    totalMessages: textMessages.length,
    totalImages: imageMessages.length,
    lastUpdated: Date.now()
  };
  
  res.json(stats);
});

// Get conversations for admin panel
app.get('/admin/conversations', (req, res) => {
  const textMessages = getTextMessages();
  const conversations = {};
  
  textMessages.forEach(msg => {
    // Create a unique key for each conversation pair, sorted alphabetically
    const user1 = msg.from < msg.to ? msg.from : msg.to;
    const user2 = msg.from < msg.to ? msg.to : msg.from;
    const key = `${user1}-${user2}`;
    
    if (!conversations[key]) {
      conversations[key] = {
        user1,
        user2,
        lastMessageTime: msg.timestamp,
        unreadCount: !msg.readAt ? 1 : 0
      };
    } else {
      // Update last message time if this message is newer
      if (msg.timestamp > conversations[key].lastMessageTime) {
        conversations[key].lastMessageTime = msg.timestamp;
      }
      
      // Count unread messages
      if (!msg.readAt) {
        conversations[key].unreadCount = (conversations[key].unreadCount || 0) + 1;
      }
    }
  });
  
  // Convert to array and sort by latest message
  const result = Object.values(conversations).sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  res.json(result);
});

// Get messages between two users for admin panel
app.get('/admin/messages', (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  const messages = getTextMessages().filter(msg => 
    (msg.from === user1 && msg.to === user2) || 
    (msg.from === user2 && msg.to === user1)
  ).sort((a, b) => a.timestamp - b.timestamp);
  
  res.json(messages);
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
