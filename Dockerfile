# Base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install Docker CLI for docker cp / docker exec
RUN apk add --no-cache docker-cli

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
