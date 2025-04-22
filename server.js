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
let messageTransitions = {}; // Store typing transitions to sent messages

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
    if (!data.from || !data.to || data.text === undefined) return;
    
    // Save typing state
    typing[data.from] = { to: data.to, text: data.text };
    
    // Clear previous timeout if exists
    if (typingTimeouts[data.from]) {
      clearTimeout(typingTimeouts[data.from]);
    }
    
    // Set timeout to clear typing state after 2 seconds of inactivity
    typingTimeouts[data.from] = setTimeout(() => {
      delete typing[data.from];
      
      // Notify recipient that typing has stopped
      if (sockets[data.to]) {
        io.to(sockets[data.to]).emit('typing', {
          from: data.from,
          to: data.to,
          text: ''
        });
      }
      
      // Also notify admins
      adminSockets.forEach(socketId => {
        io.to(socketId).emit('typing', {
          from: data.from,
          to: data.to,
          text: ''
        });
      });
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
  
  // Message transition event
  socket.on('message-transition', (data) => {
    if (!data.from || !data.to || !data.text || !data.typingId || !data.messageId) return;
    
    // Store the transition information
    messageTransitions[data.typingId] = {
      messageId: data.messageId,
      text: data.text
    };
    
    // Forward transition event to recipient
    if (sockets[data.to]) {
      io.to(sockets[data.to]).emit('message-transition', data);
    }
    
    // Also forward to admins
    adminSockets.forEach(socketId => {
      io.to(socketId).emit('message-transition', data);
    });
  });
  
  // Message status update handler (NEW FORMAT)
  socket.on('message-status', (data) => {
    if (!data.id) return;
    
    const messageId = data.id;
    const delivered = data.delivered === true;
    const readAt = data.readAt;
    
    console.log(`Received message status update: id=${messageId}, delivered=${delivered}, readAt=${readAt || 'null'}`);
    
    // Find the message in the database
    const messages = getTextMessages();
    const messageIndex = messages.findIndex(m => m.id === messageId);
    
    if (messageIndex !== -1) {
      const message = messages[messageIndex];
      
      // Update message status
      if (delivered) {
        message.delivered = true;
      }
      
      if (readAt) {
        message.readAt = readAt;
      }
      
      // Save to database
      saveTextMessages(messages);
      
      // Notify the sender of the message
      const senderId = message.from;
      if (sockets[senderId]) {
        io.to(sockets[senderId]).emit('message-status', {
          id: messageId,
          delivered: message.delivered,
          readAt: message.readAt
        });
      }
      
      // Also notify admins
      adminSockets.forEach(socketId => {
        io.to(socketId).emit('message-status', {
          id: messageId,
          delivered: message.delivered,
          readAt: message.readAt
        });
      });
    }
  });
  
  // Handle legacy read receipt format (for backward compatibility)
  socket.on('read-receipt', (data) => {
    if (!data.messageId) return;
    
    // Convert to the new message-status format
    const messageId = data.messageId;
    const timestamp = Date.now();
    
    // Use the new handler with converted data
    socket.emit('message-status', {
      id: messageId,
      delivered: true,
      readAt: timestamp
    });
  });
  
  // Handle legacy batch read receipts (for backward compatibility)
  socket.on('batch-read-receipts', (data) => {
    if (!Array.isArray(data.messageIds)) return;
    
    const timestamp = Date.now();
    
    // Convert each message ID to the new format
    data.messageIds.forEach(messageId => {
      socket.emit('message-status', {
        id: messageId,
        delivered: true,
        readAt: timestamp
      });
    });
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

// Get received images
app.get('/images/received', (req, res) => {
  try {
    const { userId, from } = req.query;
    if (!userId || !from) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const messages = getMessages().filter(msg => 
      msg.to === userId && msg.from === from
    ).sort((a, b) => a.timestamp - b.timestamp);

    // Return array of image URLs
    const imageUrls = messages.map(msg => msg.url);
    res.json(imageUrls);
  } catch (error) {
    console.error("Get received images error:", error);
    res.status(500).json({ error: "Failed to retrieve received images" });
  }
});

// Get sent images
app.get('/images/sent', (req, res) => {
  try {
    const { userId, to } = req.query;
    if (!userId || !to) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const messages = getMessages().filter(msg => 
      msg.from === userId && msg.to === to
    ).sort((a, b) => a.timestamp - b.timestamp);

    // Return array of image URLs
    const imageUrls = messages.map(msg => msg.url);
    res.json(imageUrls);
  } catch (error) {
    console.error("Get sent images error:", error);
    res.status(500).json({ error: "Failed to retrieve sent images" });
  }
});

// Get all image history for two users (both sent and received)
app.get('/images/history', (req, res) => {
  try {
    const { userId, otherId } = req.query;
    if (!userId || !otherId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const messages = getMessages().filter(msg => 
      (msg.from === userId && msg.to === otherId) || 
      (msg.from === otherId && msg.to === userId)
    ).sort((a, b) => a.timestamp - b.timestamp);

    res.json(messages);
  } catch (error) {
    console.error("Image history error:", error);
    res.status(500).json({ error: "Failed to retrieve image history" });
  }
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

// Send text message - no readAt or delivered initially
app.post('/send-message', (req, res) => {
  try {
    const { from, to, text, typingId } = req.body;
    if (!from || !to || !text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const msgId = Date.now().toString();
    const msg = {
      id: msgId,
      from,
      to,
      text,
      timestamp: Date.now()
      // No delivered or readAt initially
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

    // Send to recipient with transition info if applicable
    if (sockets[to]) {
      const messageData = { ...msg };
      
      // If this message was previously in typing state, include that info
      if (typingId) {
        messageData.isTransition = true;
        messageData.typingId = typingId;
      }
      
      io.to(sockets[to]).emit('message', messageData);
    }
    
    // Send to admins
    adminSockets.forEach(socketId => {
      io.to(socketId).emit('message', msg);
    });

    res.json({ message: 'Message sent', id: msgId });
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

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
