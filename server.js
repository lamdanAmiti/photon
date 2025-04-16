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

if (!fs.existsSync(usersDB)) fs.writeFileSync(usersDB, JSON.stringify({}));
if (!fs.existsSync(messagesDB)) fs.writeFileSync(messagesDB, JSON.stringify([]));

const getUsers = () => JSON.parse(fs.readFileSync(usersDB, 'utf8'));
const saveUsers = (users) => fs.writeFileSync(usersDB, JSON.stringify(users, null, 2));
const getMessages = () => JSON.parse(fs.readFileSync(messagesDB, 'utf8'));
const saveMessages = (msgs) => fs.writeFileSync(messagesDB, JSON.stringify(msgs, null, 2));

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

let sockets = {};

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('register', (userId) => {
    sockets[userId] = socket.id;
    console.log(`Registered user ${userId} with socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    for (let uid in sockets) {
      if (sockets[uid] === socket.id) {
        delete sockets[uid];
        break;
      }
    }
  });
});

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
    profilePhoto: req.file.filename
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

app.get('/users', (req, res) => {
  const users = getUsers();
  const sanitized = Object.values(users).map(({ userId, profilePhoto }) => ({ userId, profilePhoto }));
  res.json(sanitized);
});

app.get('/online-users', (req, res) => {
  res.json(Object.keys(sockets));
});

app.get('/images', (req, res) => {
  res.json(getMessages());
});

app.post('/send-image', upload.single('file'), (req, res) => {
  try {
    const { userIDFrom, userIDTo } = req.body;
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
    }

    res.json({ message: 'Image sent', to: userIDTo, url });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

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

  res.json({ message: 'User deleted' });
});

// Delete a specific image
app.delete('/delete-image/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const messages = getMessages().filter(m => m.filename !== filename);
  saveMessages(messages);

  res.json({ message: 'Image deleted' });
});

server.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
