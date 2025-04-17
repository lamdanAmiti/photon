const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://photon-xz0s.onrender.com";

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(__dirname));

// Create directories if they don't exist
const uploadsDir = path.join(__dirname, 'uploads');
const profilePhotosDir = path.join(__dirname, 'profile-photos');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory');
}

if (!fs.existsSync(profilePhotosDir)) {
  fs.mkdirSync(profilePhotosDir, { recursive: true });
  console.log('Created profile-photos directory');
}

app.use('/uploads', express.static(uploadsDir));
app.use('/profile-photos', express.static(profilePhotosDir));

const usersDB = path.join(__dirname, 'users.json');
const messagesDB = path.join(__dirname, 'messages.json');
const textMessagesDB = path.join(__dirname, 'text_messages.json');

// Initialize database files if they don't exist
try {
  if (!fs.existsSync(usersDB)) fs.writeFileSync(usersDB, JSON.stringify({}));
  if (!fs.existsSync(messagesDB)) fs.writeFileSync(messagesDB, JSON.stringify([]));
  if (!fs.existsSync(textMessagesDB)) fs.writeFileSync(textMessagesDB, JSON.stringify([]));
} catch (error) {
  console.error('Error initializing database files:', error);
}

const getUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(usersDB, 'utf8'));
  } catch (error) {
    console.error('Error reading users database:', error);
    return {};
  }
};

const saveUsers = (users) => {
  try {
    fs.writeFileSync(usersDB, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Error saving users database:', error);
  }
};

const getMessages = () => {
  try {
    return JSON.parse(fs.readFileSync(messagesDB, 'utf8'));
  } catch (error) {
    console.error('Error reading messages database:', error);
    return [];
  }
};

const saveMessages = (msgs) => {
  try {
    fs.writeFileSync(messagesDB, JSON.stringify(msgs, null, 2));
  } catch (error) {
    console.error('Error saving messages database:', error);
  }
};

const getTextMessages = () => {
  try {
    return JSON.parse(fs.readFileSync(textMessagesDB, 'utf8'));
  } catch (error) {
    console.error('Error reading text messages database:', error);
    return [];
  }
};

const saveTextMessages = (msgs) => {
  try {
    fs.writeFileSync(textMessagesDB, JSON.stringify(msgs, null, 2));
  } catch (error) {
    console.error('Error saving text messages database:', error);
  }
};

const storageImage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const storageProfile = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, profilePhotosDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storageImage });
const uploadProfile = multer({ storage: storageProfile });

let sockets = {};

io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('register', (userId) => {
    if (userId) {
      sockets[userId] = socket.id;
      console.log(`Registered user ${userId} with socket ${socket.id}`);
    } else {
      console.log('Received register event without userId');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected', socket.id);
    for (let uid in sockets) {
      if (sockets[uid] === socket.id) {
        delete sockets[uid];
        console.log(`Unregistered user ${uid}`);
        break;
      }
    }
  });
});

// User registration with password and profile picture
app.post('/register', uploadProfile.single('profilePhoto'), (req, res) => {
  try {
    const { userId, password } = req.body;
    
    if (!userId || !password) {
      return res.status(400).json({ error: 'Missing userId or password' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'Missing profilePhoto' });
    }

    const users = getUsers();
    if (users[userId]) {
      return res.status(400).json({ error: 'User already exists' });
    }

    users[userId] = {
      userId,
      password,
      profilePhoto: req.file.filename
    };

    saveUsers(users);
    console.log(`User registered: ${userId}`);
    res.json({ message: 'User registered successfully', profilePhoto: req.file.filename });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed due to server error' });
  }
});

// Login with password
app.post('/login', (req, res) => {
  try {
    const { userId, password } = req.body;
    
    if (!userId || !password) {
      return res.status(400).json({ error: 'Missing userId or password' });
    }
    
    const users = getUsers();
    const user = users[userId];
    
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    console.log(`User logged in: ${userId}`);
    res.json({ message: 'Login successful', profilePhoto: user.profilePhoto });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed due to server error' });
  }
});

app.get('/users', (req, res) => {
  try {
    const users = getUsers();
    const sanitized = Object.values(users).map(({ userId, profilePhoto }) => ({ userId, profilePhoto }));
    res.json(sanitized);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/online-users', (req, res) => {
  try {
    res.json(Object.keys(sockets));
  } catch (error) {
    console.error('Error fetching online users:', error);
    res.status(500).json({ error: 'Failed to fetch online users' });
  }
});

app.get('/images', (req, res) => {
  try {
    res.json(getMessages());
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

app.post('/send-image', upload.single('file'), (req, res) => {
  try {
    const { userIDFrom, userIDTo } = req.body;
    
    if (!userIDFrom || !userIDTo) {
      return res.status(400).json({ error: 'Missing userIDFrom or userIDTo' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const filename = req.file.filename;
    const url = `${BASE_URL}/uploads/${filename}`;

    const msg = {
      from: userIDFrom,
      to: userIDTo,
      url,
      filename,
      timestamp: Date.now()
    };

    const messages = getMessages();
    messages.push(msg);
    saveMessages(messages);

    if (sockets[userIDTo]) {
      io.to(sockets[userIDTo]).emit('image', msg);
      console.log(`Sent real-time image notification to ${userIDTo}`);
    } else {
      console.log(`User ${userIDTo} not online, image saved to database`);
    }

    res.json({ message: 'Image sent', to: userIDTo, url });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// New endpoint for sending text messages
app.post('/send-message', (req, res) => {
  try {
    const { from, to, text } = req.body;
    
    if (!from || !to || !text) {
      return res.status(400).json({ error: 'Missing required fields: from, to, or text' });
    }
    
    const messageId = uuidv4();
    const timestamp = Date.now();
    
    const msg = {
      id: messageId,
      from,
      to,
      text,
      timestamp
    };
    
    const messages = getTextMessages();
    messages.push(msg);
    saveTextMessages(messages);
    
    // Send real-time message via socket if user is online
    if (sockets[to]) {
      io.to(sockets[to]).emit('message', msg);
      console.log(`Sent real-time message notification to ${to}`);
    } else {
      console.log(`User ${to} not online, message saved to database`);
    }
    
    res.json({ 
      message: 'Message sent', 
      messageId,
      to, 
      timestamp
    });
  } catch (error) {
    console.error("Message send error:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Get message history between two users
app.get('/message-history', (req, res) => {
  try {
    const { userId, otherId } = req.query;
    
    if (!userId || !otherId) {
      return res.status(400).json({ error: 'Missing required query parameters: userId or otherId' });
    }
    
    const messages = getTextMessages();
    
    // Filter messages that involve both users
    const relevantMessages = messages.filter(msg => 
      (msg.from === userId && msg.to === otherId) || 
      (msg.from === otherId && msg.to === userId)
    );
    
    // Sort by timestamp (oldest first)
    relevantMessages.sort((a, b) => a.timestamp - b.timestamp);
    
    res.json(relevantMessages);
  } catch (error) {
    console.error("Message history fetch error:", error);
    res.status(500).json({ error: "Failed to fetch message history" });
  }
});

app.delete('/delete-user/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    const users = getUsers();
    if (!users[userId]) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete profile picture if it exists
    const profilePic = users[userId].profilePhoto;
    const profilePath = path.join(profilePhotosDir, profilePic);
    if (fs.existsSync(profilePath)) {
      try {
        fs.unlinkSync(profilePath);
        console.log(`Deleted profile photo: ${profilePath}`);
      } catch (err) {
        console.error(`Error deleting profile photo: ${err.message}`);
      }
    }

    delete users[userId];
    saveUsers(users);

    // Delete user's messages
    const messages = getMessages().filter(m => m.from !== userId && m.to !== userId);
    saveMessages(messages);
    
    // Also remove text messages
    const textMessages = getTextMessages().filter(m => m.from !== userId && m.to !== userId);
    saveTextMessages(textMessages);

    console.log(`User deleted: ${userId}`);
    res.json({ message: 'User deleted' });
  } catch (error) {
    console.error(`Error deleting user: ${error}`);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.delete('/delete-image/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Missing filename parameter' });
    }
    
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Deleted image file: ${filePath}`);
      } catch (err) {
        console.error(`Error deleting image file: ${err.message}`);
      }
    }

    const messages = getMessages().filter(m => m.filename !== filename);
    saveMessages(messages);

    res.json({ message: 'Image deleted' });
  } catch (error) {
    console.error(`Error deleting image: ${error}`);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Delete a text message
app.delete('/delete-message/:messageId', (req, res) => {
  try {
    const messageId = req.params.messageId;
    if (!messageId) {
      return res.status(400).json({ error: 'Missing messageId parameter' });
    }
    
    const messages = getTextMessages();
    const filteredMessages = messages.filter(m => m.id !== messageId);
    
    if (messages.length === filteredMessages.length) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    saveTextMessages(filteredMessages);
    console.log(`Message deleted: ${messageId}`);
    res.json({ message: 'Message deleted' });
  } catch (error) {
    console.error(`Error deleting message: ${error}`);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// Root route with information
app.get('/', (req, res) => {
  res.send(`
    <h1>Photon Server</h1>
    <p>Server is running. API endpoints available at:</p>
    <ul>
      <li>/register - Register new user</li>
      <li>/login - Login existing user</li>
      <li>/users - Get all users</li>
      <li>/online-users - Get online users</li>
      <li>/images - Get all images</li>
      <li>/send-image - Send an image</li>
      <li>/send-message - Send a text message</li>
      <li>/message-history - Get message history</li>
      <li>/health - Server health check</li>
    </ul>
  `);
});

// Handle 404 errors
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error', message: err.message });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`BASE_URL set to ${BASE_URL}`);
});
