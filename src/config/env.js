import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: process.env.PORT || 4000,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/chitz',
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173'
};
