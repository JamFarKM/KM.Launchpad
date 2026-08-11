# syntax=docker/dockerfile:1

# ---- Stage 1: build the React frontend ----
FROM node:22-alpine AS web
WORKDIR /web
COPY src/web/package*.json ./
RUN npm ci
COPY src/web/ ./
RUN npm run build
# outputs to /web/dist

# ---- Stage 2: build the .NET backend ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS server
WORKDIR /src
COPY NuGet.config ./
COPY src/server/*.csproj ./
RUN dotnet restore
COPY src/server/ ./
# bring in the built SPA so it is published as static content
COPY --from=web /web/dist ./wwwroot
RUN dotnet publish -c Release -o /app --no-restore

# ---- Stage 3: runtime ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=server /app ./
# persisted state (SQLite db + data-protection keys) lives here
VOLUME ["/data"]
ENV ASPNETCORE_URLS=http://+:8080 \
    PL_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["dotnet", "PipelineLaunchpad.Server.dll"]
