# 基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装 docker 客户端，用于执行 docker cp / docker exec
RUN apk add --no-cache docker-cli

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["npm", "start"]
