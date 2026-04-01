import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const httpServer = http.createServer(app);

/* ==================== SECURITY & PARSING ==================== */
app.use(helmet());
app.use(express.json()); // 👉 ADDED: Required to read POST request bodies

const ALLOWED_ORIGINS = [
  process.env.CLIENT_URL || "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  process.env.CLIENT_URL,
  "https://codechange.online",
  "https://www.codechange.online",
];

/* ==================== CORS ==================== */
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

/* ==================== RATE LIMITING ==================== */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/", apiLimiter);

/* ==================== ROOM STORE ==================== */
const rooms = new Map(); // roomId → messages[]
const roomTimeouts = new Map(); // roomId → deletion timeout

/* ==================== API ROUTES ==================== */
// 👉 ADDED: This is the route your frontend is calling to get the 6-digit code
app.post("/room-create", (req, res) => {
  try {
    let roomId;
    // Generate 6-digit random ID
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(roomId));

    // Create empty room
    console.log(`Creating room with ID: ${roomId}`);
    rooms.set(roomId, []);
    console.log(`🆕 Room created via API: ${roomId}`);

    // Set 5-minute auto-delete if no one joins via socket
    const timeout = setTimeout(
      () => {
        rooms.delete(roomId);
        roomTimeouts.delete(roomId);
        console.log(
          `🧹 Room ${roomId} deleted (created but never joined in 5 mins)`,
        );
      },
      5 * 60 * 1000,
    );

    roomTimeouts.set(roomId, timeout);

    // Send the ID back to Next.js
    res.status(200).json({ success: true, roomId });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ==================== SOCKET.IO SETUP ==================== */
const io = new Server(httpServer, {
  path: "/socket.io",
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  reconnection: true,
});

/* ==================== SPAM PROTECTION ==================== */
const MESSAGE_LIMIT = 5;
const TIME_WINDOW = 1000;
const userRateLimits = new Map();

function isRateLimited(socketId) {
  const now = Date.now();
  if (!userRateLimits.has(socketId)) {
    userRateLimits.set(socketId, [{ timestamp: now }]);
    return false;
  }

  let requests = userRateLimits.get(socketId);
  requests = requests.filter((req) => now - req.timestamp < TIME_WINDOW);

  if (requests.length >= MESSAGE_LIMIT) return true;

  requests.push({ timestamp: now });
  userRateLimits.set(socketId, requests);
  return false;
}

/* ==================== SOCKET EVENTS ==================== */
io.on("connection", (socket) => {
  console.log(`🔗 User connected: ${socket.id}`);

  socket.on("room:join", ({ roomId }) => {
    if (isRateLimited(socket.id)) {
      return socket.emit("room:error", "Slow down! You're sending too fast.");
    }

    if (!roomId || typeof roomId !== "string" || roomId.length !== 6) {
      return socket.emit("room:error", "Invalid Room ID");
    }

    // Agar room nahi hai toh create kar do
    if (!rooms.has(roomId)) {
      rooms.set(roomId, []);
      console.log(`🆕 New room created on join: ${roomId}`);
    }

    // Agar deletion timeout tha toh cancel kar do
    if (roomTimeouts.has(roomId)) {
      clearTimeout(roomTimeouts.get(roomId));
      roomTimeouts.delete(roomId);
      console.log(`✅ Room ${roomId} saved from deletion`);
    }

    socket.join(roomId);
    console.log(`👤 User ${socket.id} joined room: ${roomId}`);

    // Dusre users ko notification
    socket.to(roomId).emit("user:joined");

    // Naye user ko purana history bhej do
    socket.emit("room:messages", rooms.get(roomId));
  });

  socket.on("code:send", ({ roomId, code }) => {
    if (isRateLimited(socket.id)) {
      return socket.emit("room:error", "Sending too fast! Slow down.");
    }

    if (!roomId || !rooms.has(roomId)) {
      return socket.emit("room:error", "Room not found");
    }

    if (!code || typeof code !== "string") {
      return socket.emit("room:error", "Invalid code");
    }

    if (code.length > 50000) {
      return socket.emit("room:error", "Code is too large (max 50KB)");
    }

    const msg = { id: Date.now(), code };

    rooms.get(roomId).push(msg);
    io.to(roomId).emit("code:new", msg);
  });

  // Disconnect handling with auto-cleanup
  socket.on("disconnecting", () => {
    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        const roomSockets = io.sockets.adapter.rooms.get(roomId);
        if (roomSockets && roomSockets.size <= 1) {
          console.log(
            `⏳ Room ${roomId} is now empty. Will delete in 5 minutes...`,
          );

          const timeout = setTimeout(
            () => {
              rooms.delete(roomId);
              roomTimeouts.delete(roomId);
              console.log(
                `🧹 Room ${roomId} permanently deleted (inactive for 5 mins)`,
              );
            },
            5 * 60 * 1000,
          );

          roomTimeouts.set(roomId, timeout);
        }
      }
    });
  });

  socket.on("disconnect", () => {
    userRateLimits.delete(socket.id);
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

/* ==================== HEALTH CHECK ==================== */
app.get("/", (req, res) => {
  res.status(200).json({
    status: "✅ Backend is running perfectly",
    activeRooms: rooms.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/* ==================== START SERVER ==================== */
// 👉 Frontend fetch request port 3001 use kar rahi hai
const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.io path: /socket.io`);
  console.log(`🌐 Allowed origins:`, ALLOWED_ORIGINS);
});
