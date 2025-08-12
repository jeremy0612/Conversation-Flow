## Test record 
cd /home/deepx/Documents/keenon_mic && UPLOAD_URL="https://4c3d6c0c922c.ngrok-free.app/transcribe" ARECORD_DEVICE="hw:5,0" ARECORD_DURATION="2" ARECORD_FORMAT="S16_LE" ARECORD_RATE="16000" ./build/audio_uploader

## Build with websocket client --> server (audio)
cd /home/deepx/Documents/keenon_mic && rm -rf build && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release | cat && cmake --build build -j$(nproc) | cat
## Run websocket client (record audio and send)
ARECORD_DEVICE="hw:5,0" A
RECORD_FORMAT="S16_LE" ARECORD_RATE="16000" ./build/audio_uploader