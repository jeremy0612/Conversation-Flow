import asyncio
import websockets
import json
import pyaudio
import base64
import uuid
import logging
from datetime import datetime

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AudioStreamClient:
    def __init__(self, server_url: str = "wss://localhost:8000"):
        self.server_url = server_url
        self.client_id = str(uuid.uuid4())[:8]
        self.websocket = None
        self.audio = None
        self.stream = None
        self.running = False
        
        # Audio configuration - matching OpenAI requirements
        self.CHUNK = 1024
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = 1
        self.RATE = 16000  # 24kHz for OpenAI
        
        logger.info(f"🎯 Audio Stream Client initialized. ID: {self.client_id}")
    
    async def connect_to_server(self):
        """Connect to the streaming server"""
        try:
            # Add the router prefix for ASR stream service
            uri = f"{self.server_url}/api/asr-batch-stream/ws/{self.client_id}"
            self.websocket = await websockets.connect(uri)
            logger.info(f"✅ Connected to server: {uri}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to connect to server: {e}")
            return False
    
    def start_audio_recording(self):
        """Start recording audio from microphone"""
        try:
            self.audio = pyaudio.PyAudio()
            
            # List available audio devices (optional, for debugging)
            info = self.audio.get_host_api_info_by_index(0)
            logger.info(f"🎤 Audio System: {info.get('name')}")
            
            self.stream = self.audio.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.CHUNK
            )
            
            logger.info(f"🎤 Started recording: {self.RATE}Hz, {self.CHANNELS} channel(s), {self.CHUNK} frames/buffer")
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to start audio recording: {e}")
            return False
    
    async def send_audio_data(self):
        """Send audio data to server"""
        logger.info("🎵 Starting audio streaming...")
        
        try:
            while self.running:
                # Read audio data from microphone
                audio_data = self.stream.read(self.CHUNK, exception_on_overflow=False)
                
                # Encode as base64
                audio_b64 = base64.b64encode(audio_data).decode('utf-8')
                
                # Send to server
                message = {
                    "type": "audio",
                    "data": audio_b64,
                    "timestamp": datetime.now().isoformat(),
                    "client_id": self.client_id
                }
                
                await self.websocket.send(json.dumps(message))
                
                # Small delay to prevent overwhelming
                await asyncio.sleep(0.01)
                
        except Exception as e:
            logger.error(f"❌ Error sending audio data: {e}")
            self.running = False
    
    async def listen_for_responses(self):
        """Listen for responses from server"""
        logger.info("👂 Listening for server responses...")
        
        try:
            async for message in self.websocket:
                data = json.loads(message)
                message_type = data.get("type", "")
                
                if message_type == "connected":
                    logger.info(f"🎉 {data.get('message')}")
                    server_info = data.get("server_info", {})
                    logger.info(f"🔧 Server Audio Format: {server_info.get('audio_format')}")
                    logger.info(f"🌍 Language: {server_info.get('language')}")
                
                elif message_type == "transcription":
                    event_type = data.get("event_type", "")
                    text = data.get("text", "")
                    
                    if event_type == "completed":
                        print(f"\n📝 [COMPLETED] {text}")
                    elif event_type == "delta":
                        print(f"🔄 [PARTIAL] {text}", end="", flush=True)
                    elif event_type == "speech_started":
                        print("\n🗣️ [SPEECH STARTED]")
                    elif event_type == "speech_stopped":
                        print("\n🔇 [SPEECH STOPPED]")
                    elif event_type == "error":
                        print(f"\n❌ [ERROR] {text}")
                
                elif message_type == "pong":
                    logger.debug("🏓 Received pong from server")
                
                elif message_type == "error":
                    logger.error(f"❌ Server error: {data.get('message')}")
                    print(f"\n❌ Server Error: {data.get('message')}")
                
                elif message_type == "config_ack":
                    logger.info(f"✅ Config acknowledged: {data.get('message')}")
                
                else:
                    logger.debug(f"📨 Server message: {message_type}")
                    logger.debug(f"📄 Message content: {data}")
                    
        except websockets.exceptions.ConnectionClosed:
            logger.warning("🔌 Server connection closed")
        except Exception as e:
            logger.error(f"❌ Error listening to server: {e}")
    
    async def send_ping(self):
        """Send periodic ping to keep connection alive"""
        while self.running:
            try:
                ping_message = {
                    "type": "ping",
                    "timestamp": datetime.now().isoformat()
                }
                await self.websocket.send(json.dumps(ping_message))
                await asyncio.sleep(30)  # Ping every 30 seconds
            except:
                break
    
    async def send_config(self):
        """Send initial configuration to server"""
        try:
            config_message = {
                "type": "config",
                "config": {
                    "audio_format": "pcm16",
                    "sample_rate": self.RATE,
                    "channels": self.CHANNELS,
                    "chunk_size": self.CHUNK
                }
            }
            await self.websocket.send(json.dumps(config_message))
            logger.info("📋 Configuration sent to server")
        except Exception as e:
            logger.error(f"❌ Error sending config: {e}")
    
    async def start_streaming(self):
        """Start the complete streaming process"""
        logger.info("🚀 Starting Audio Stream Client...")
        
        # Connect to server
        if not await self.connect_to_server():
            return
        
        # Start audio recording
        if not self.start_audio_recording():
            return
        
        # Send initial configuration
        await self.send_config()
        
        self.running = True
        
        try:
            # Run all tasks concurrently
            await asyncio.gather(
                self.send_audio_data(),
                self.listen_for_responses(),
                self.send_ping()
            )
        except KeyboardInterrupt:
            logger.info("\n⏹️ Stopping audio stream...")
        finally:
            await self.cleanup()
    
    async def cleanup(self):
        """Clean up resources"""
        logger.info("🧹 Cleaning up...")
        self.running = False
        
        # Stop audio recording
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
            logger.info("🎤 Audio recording stopped")
        
        if self.audio:
            self.audio.terminate()
            logger.info("🔊 Audio system terminated")
        
        # Close WebSocket connection
        if self.websocket:
            await self.websocket.close()
            logger.info("🔌 WebSocket connection closed")
        
        logger.info("✅ Cleanup complete")

async def main():
    # Configuration
    SERVER_URL = "ws://localhost:9999"

    
    # Create and start client
    client = AudioStreamClient(SERVER_URL)
    
    print("🎯 Audio Stream Client")
    print("=" * 50)
    print(f"📡 Server: {SERVER_URL}")
    print(f"🔗 WebSocket: {SERVER_URL}/api/asr-batch-stream/ws/{client.client_id}")
    print(f"🆔 Client ID: {client.client_id}")
    print("🎤 Audio: 24kHz PCM16 Mono")
    print("Press Ctrl+C to stop")
    print("=" * 50)
    
    await client.start_streaming()

if __name__ == "__main__":
    # Check if required packages are available
    try:
        import pyaudio
        import websockets
    except ImportError as e:
        logger.error(f"❌ Missing required package: {e}")
        print("Please install required packages:")
        print("pip install pyaudio websockets")
        exit(1)
    
    # Run the client
    asyncio.run(main())
