const jwt = require('jsonwebtoken');

module.exports = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Missing auth token'));
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.userId;
      return next();
    } catch (_error) {
      return next(new Error('Socket authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id, 'user:', socket.userId);

    // Every authenticated socket joins a personal room used for private events.
    socket.join(`user-${socket.userId}`);

    // Join barber room for real-time updates
    socket.on('join-barber-room', (barberId) => {
      socket.join(`barber-${barberId}`);
    });

    // Join customer room
    socket.on('join-customer-room', (customerId) => {
      socket.join(`customer-${customerId}`);
    });

    socket.on('join-booking-room', (bookingId) => {
      socket.join(`booking-${bookingId}`);
    });

    // Notify queue updates
    socket.on('queue-update', (data) => {
      io.to(`barber-${data.barberId}`).emit('queue-updated', data);
    });

    socket.on('barber-location-update', (data) => {
      io.to(`booking-${data.bookingId}`).emit('barber-location-updated', data);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });
};