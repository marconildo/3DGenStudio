docker buildx build --platform linux/arm64 -t 3dgenstudio-server:latest --load .
docker save 3dgenstudio-server:latest -o genstudio-server.tar
