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

/* ---------- SECURITY UPGRADES ---------- */
// Helmet adds important security headers
app.use(helmet());

// Strict CORS: Replace with your frontend URL in production
const ALLOWED_ORIGIN = process.env.CLIENT_URL || "http://localhost:3000";
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

/* ---------- RATE LIMITING (HTTP) ---------- */
// Prevents DDoS and brute-force attacks on REST endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: "Too many requests from this IP, please try again later.",
});
app.use("/", apiLimiter);

/* ---------- SOCKET.IO SETUP ---------- */
const io = new Server(httpServer, {
  path: "/socket.io",
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["polling", "websocket"],
});

/* ---------- ROOM STORE & MEMORY MANAGEMENT ---------- */
const rooms = new Map();

function generateRoomId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ---------- SOCKET SPAM PROTECTION ---------- */
// Prevents a single user from flooding the server with socket events
const MESSAGE_LIMIT = 5;
const TIME_WINDOW = 1000; // 1 second
const userRateLimits = new Map();

function isRateLimited(socketId) {
  const now = Date.now();
  if (!userRateLimits.has(socketId)) {
    userRateLimits.set(socketId, [{ timestamp: now }]);
    return false;
  }

  let requests = userRateLimits.get(socketId);
  // Remove requests older than TIME_WINDOW
  requests = requests.filter((req) => now - req.timestamp < TIME_WINDOW);

  if (requests.length >= MESSAGE_LIMIT) {
    return true; // Rate limited!
  }

  requests.push({ timestamp: now });
  userRateLimits.set(socketId, requests);
  return false;
}

/* ---------- SOCKET EVENTS ---------- */
io.on("connection", (socket) => {
  console.log("🔗 User connected:", socket.id);

  socket.on("room:create", () => {
    if (isRateLimited(socket.id))
      return socket.emit("error:spam", "Slow down!");

    let id;
    do {
      id = generateRoomId();
    } while (rooms.has(id));

    rooms.set(id, []);
    socket.join(id);

    console.log("🆕 Room created:", id);
    socket.emit("room:created", { roomId: id });
  });

  socket.on("room:join", ({ roomId }) => {
    if (isRateLimited(socket.id))
      return socket.emit("error:spam", "Slow down!");

    // Validate Input
    if (!roomId || typeof roomId !== "string") {
      return socket.emit("room:error", "Invalid Room ID");
    }

    if (!rooms.has(roomId)) {
      socket.emit("room:error", "Room not found");
      return;
    }

    socket.join(roomId);
    socket.emit("room:messages", rooms.get(roomId));
  });

  socket.on("code:send", ({ roomId, code }) => {
    if (isRateLimited(socket.id))
      return socket.emit("error:spam", "Sending code too fast!");

    if (!rooms.has(roomId)) return; // Prevent crash if room doesn't exist

    // Limit payload size to prevent memory crash attacks
    if (code && code.length > 50000) {
      return socket.emit("room:error", "Payload too large");
    }

    const msg = { id: Date.now(), code };
    rooms.get(roomId)?.push(msg);
    io.to(roomId).emit("code:new", msg);
  });

  // MEMORY LEAK FIX: Clean up rooms when users leave
  socket.on("disconnecting", () => {
    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        // ignore the default room
        const roomSockets = io.sockets.adapter.rooms.get(roomId);
        // If this user is the last one in the room, delete the room data
        if (roomSockets && roomSockets.size <= 1) {
          rooms.delete(roomId);
          console.log(`🧹 Room ${roomId} deleted (empty)`);
        }
      }
    });
  });

  socket.on("disconnect", () => {
    userRateLimits.delete(socket.id); // Clean up rate limit data
    console.log("❌ User disconnected:", socket.id);
  });
});

/* ---------- HEALTH CHECK ROUTE ---------- */
app.get("/", (req, res) => {
  res.status(200).json({
    status: "healthy",
    message: "Secure Backend is running (In-Memory Adapter)",
    activeRooms: rooms.size,
  });
});

/* ---------- START ---------- */
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
