#!/data/data/com.termux/files/usr/bin/bash
pkill -f "node server.js" && echo "Stopped" || echo "Not running"
