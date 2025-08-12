#include <websocketpp/client.hpp>
#include <websocketpp/config/asio_client.hpp>
#include <boost/asio/ssl.hpp>
#include <curl/curl.h>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <filesystem>
#include <fstream>
#include <chrono>
#include <random>
#include <cstdio>
#include <regex>
#include <cstring>

using namespace std::chrono_literals;

// Define WebSocket client types
using Client = websocketpp::client<websocketpp::config::asio_tls_client>;
using ConnectionHdl = websocketpp::connection_hdl;
using ErrorCode = websocketpp::lib::error_code;

// Helper function to get environment variables
static std::string getEnv(const char* key, const std::string& def = "") {
    const char* v = std::getenv(key);
    return v ? std::string(v) : def;
}

// Callback function to write received data to a vector
static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t realsize = size * nmemb;
    auto* vec = static_cast<std::vector<char>*>(userp);
    
    size_t currentSize = vec->size();
    vec->resize(currentSize + realsize);
    std::memcpy(vec->data() + currentSize, contents, realsize);
    
    return realsize;
}

class TTSClient {
public:
    TTSClient() {
        // Initialize CURL
        curl_global_init(CURL_GLOBAL_ALL);
        curl = curl_easy_init();
        if (!curl) {
            throw std::runtime_error("Failed to initialize CURL");
        }
        
        // Set common options
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        
        // Set headers
        headers = curl_slist_append(headers, "Content-Type: application/json");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    }
    
    ~TTSClient() {
        if (headers) {
            curl_slist_free_all(headers);
        }
        if (curl) {
            curl_easy_cleanup(curl);
        }
        curl_global_cleanup();
    }
    
    bool textToSpeech(const std::string& text, const std::string& outputFile) {
        if (!curl) return false;
        
        try {
            // Prepare JSON payload
            std::string jsonPayload = "{\"text\": \"" + text + "\"}";
            
            // Set POST data
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonPayload.c_str());
            
            // Set URL
            std::string url = getEnv("TTS_URL", "https://robot-asr.pvi.digital/api/tts/stream");
            curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
            
            // Buffer for response
            std::vector<char> responseBuffer;
            curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBuffer);
            
            // Perform request
            std::cout << "🎤 Requesting TTS for text: " << text << std::endl;
            CURLcode res = curl_easy_perform(curl);
            
            if (res != CURLE_OK) {
                std::cerr << "❌ Failed to perform request: " 
                          << curl_easy_strerror(res) << std::endl;
                return false;
            }
            
            // Get HTTP response code
            long httpCode = 0;
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
            
            if (httpCode != 200) {
                std::cerr << "❌ Server returned HTTP code " << httpCode << std::endl;
                return false;
            }
            
            // Save response to file
            std::ofstream outFile(outputFile, std::ios::binary);
            if (!outFile) {
                std::cerr << "❌ Failed to open output file: " << outputFile << std::endl;
                return false;
            }
            
            outFile.write(responseBuffer.data(), responseBuffer.size());
            outFile.close();
            
            std::cout << "✅ Audio saved to: " << outputFile << std::endl;
            return true;
            
        } catch (const std::exception& e) {
            std::cerr << "❌ Error in textToSpeech: " << e.what() << std::endl;
            return false;
        }
    }
    
    bool playAudio(const std::string& audioFile) {
        try {
            // Play audio using paplay (PulseAudio)
            std::string playCmd = "paplay '" + audioFile + "'";
            std::cout << "🎵 Playing audio: " << playCmd << std::endl;
            
            int result = system(playCmd.c_str());
            if (result != 0) {
                std::cerr << "❌ Failed to play audio, paplay returned: " 
                          << result << std::endl;
                return false;
            }
            
            return true;
        } catch (const std::exception& e) {
            std::cerr << "❌ Error playing audio: " << e.what() << std::endl;
            return false;
        }
    }

private:
    CURL* curl = nullptr;
    struct curl_slist* headers = nullptr;
};

class WebSocketClient {
public:
    WebSocketClient() {
        // Generate device ID
        deviceId = "0612";
        
        // Open log file
        std::string timestamp = getCurrentTimestamp();
        logFilePath = "websocket_log_" + timestamp + ".txt";
        logFile.open(logFilePath, std::ios::app);
        if (!logFile.is_open()) {
            std::cerr << "Failed to open log file: " << logFilePath << std::endl;
        }
        
        // Initialize TTS client
        ttsClient = std::make_unique<TTSClient>();
        
        // Set up WebSocket client
        client.clear_access_channels(websocketpp::log::alevel::all);
        client.set_access_channels(websocketpp::log::alevel::connect);
        client.set_access_channels(websocketpp::log::alevel::disconnect);
        client.set_access_channels(websocketpp::log::alevel::app);
        
        client.clear_error_channels(websocketpp::log::elevel::all);
        client.set_error_channels(websocketpp::log::elevel::warn);
        client.set_error_channels(websocketpp::log::elevel::rerror);
        client.set_error_channels(websocketpp::log::elevel::fatal);
        
        client.init_asio();
        
        // Configure TLS
        client.set_tls_init_handler([](websocketpp::connection_hdl) {
            auto ctx = std::make_shared<boost::asio::ssl::context>(boost::asio::ssl::context::sslv23);
            ctx->set_options(boost::asio::ssl::context::default_workarounds |
                           boost::asio::ssl::context::no_sslv2 |
                           boost::asio::ssl::context::no_sslv3 |
                           boost::asio::ssl::context::single_dh_use);
            ctx->set_verify_mode(boost::asio::ssl::verify_none);
            return ctx;
        });
        
        // Register message handler
        client.set_message_handler([this](ConnectionHdl hdl, Client::message_ptr msg) {
            handleServerMessage(msg->get_payload());
        });
        
        // Register connection handlers
        client.set_open_handler([this](ConnectionHdl hdl) {
            std::cout << "✅ WebSocket connection established" << std::endl;
            connected = true;
            connectionFailed = false;
            
            // Send Socket.IO connection packet
            sendConnectPacket();
        });
        
        client.set_close_handler([this](ConnectionHdl hdl) {
            std::cout << "🔌 WebSocket connection closed" << std::endl;
            connected = false;
        });
        
        client.set_fail_handler([this](ConnectionHdl hdl) {
            auto con = client.get_con_from_hdl(hdl);
            std::cout << "❌ WebSocket connection failed. Error: " 
                      << con->get_ec().message() << std::endl;
            connected = false;
            connectionFailed = true;
        });
    }
    
    void handleServerMessage(const std::string& message) {
        try {
            std::cout << "📥 Received: " << message << std::endl;
            logMessage(message);
            
            // Handle Socket.IO packets
            if (message.empty()) return;
            
            char type = message[0];
            std::string payload = message.length() > 1 ? message.substr(1) : "";
            
            switch (type) {
                case '0': // Socket.IO connect
                    std::cout << "🔌 Socket.IO connected" << std::endl;
                    logMessage("Socket.IO connected", "INFO");
                    break;
                    
                case '2': // Socket.IO ping - respond with pong
                    std::cout << "🏓 Ping received, sending pong" << std::endl;
                    logMessage("Ping received, sending pong", "INFO");
                    client.send(connection, "3", websocketpp::frame::opcode::text);
                    break;
                    
                case '4': // Socket.IO message/event
                    logMessage("Processing Socket.IO message/event", "INFO");
                    
                    // Parse event message format: 42/tts,["event_name",{...}]
                    size_t commaPos = payload.find(',');
                    if (commaPos != std::string::npos) {
                        std::string eventData = payload.substr(commaPos + 1);
                        
                        // Check for navigation event with message
                        if (eventData.find("\"navigation\"") != std::string::npos) {
                            handleNavigationMessage(eventData);
                        }
                    }
                    break;
            }
            
        } catch (const std::exception& e) {
            std::string error = "Error handling message: " + std::string(e.what());
            std::cerr << error << std::endl;
            logMessage(error, "ERROR");
        }
    }
    
    void handleNavigationMessage(const std::string& payload) {
        try {
            // Extract message from navigation event
            size_t messageStart = payload.find("\"message\":\"");
            if (messageStart == std::string::npos) return;
            
            messageStart += 11; // Move past "message":"
            size_t messageEnd = payload.find("\"", messageStart);
            if (messageEnd == std::string::npos) return;
            
            std::string message = payload.substr(messageStart, messageEnd - messageStart);
            if (message.empty()) return;
            
            std::cout << "📢 Navigation message: " << message << std::endl;
            logMessage("Navigation message: " + message, "INFO");
            
            // Create temporary file for audio
            std::string tempFile = "/tmp/tts_" + getCurrentTimestamp() + ".wav";
            
            // Get TTS audio and play it
            if (ttsClient->textToSpeech(message, tempFile)) {
                ttsClient->playAudio(tempFile);
                std::filesystem::remove(tempFile);
            }
            
        } catch (const std::exception& e) {
            std::string error = "Error handling navigation message: " + std::string(e.what());
            std::cerr << error << std::endl;
            logMessage(error, "ERROR");
        }
    }
    
    bool tryConnect(const std::string& baseUrl) {
        try {
            // First perform Socket.IO handshake
            std::string handshakeUrl = baseUrl + "/socket.io/?EIO=4&transport=websocket";
            std::cout << "🔄 Connecting to: " << handshakeUrl << std::endl;
            
            websocketpp::lib::error_code ec;
            connection = client.get_connection(handshakeUrl, ec);
            if (ec) {
                std::cerr << "Failed to create connection: " << ec.message() << std::endl;
                return false;
            }
            
            // Set required headers for Socket.IO
            connection->append_header("ngrok-skip-browser-warning", "true");
            connection->append_header("User-Agent", "C++-SocketIO-Client");
            
            client.connect(connection);
            
            // Start the ASIO io_service run loop
            if (!clientThread.joinable()) {
                clientThread = std::thread([this]() {
                    try {
                        client.run();
                    } catch (const std::exception& e) {
                        std::cerr << "WebSocket thread error: " << e.what() << std::endl;
                        connected = false;
                        connectionFailed = true;
                    }
                });
            }
            
            // Wait for connection
            for (int i = 0; i < 10 && !connected && !connectionFailed; ++i) {
                std::this_thread::sleep_for(100ms);
            }
            
            return connected;
        } catch (const std::exception& e) {
            std::cerr << "Connection attempt failed: " << e.what() << std::endl;
            return false;
        }
    }
    
    void sendConnectPacket() {
        if (!connected) return;
        
        // Socket.IO connect packet to /tts namespace with auth data
        std::stringstream ss;
        ss << "40/tts,{\"auth\":{\"deviceId\":\"" << deviceId << "\"}}";
        
        websocketpp::lib::error_code ec;
        client.send(connection, ss.str(), websocketpp::frame::opcode::text, ec);
        if (ec) {
            std::cerr << "Failed to send connect packet: " << ec.message() << std::endl;
        } else {
            std::cout << "🔌 Socket.IO connect packet sent to /tts" << std::endl;
        }
    }
    
    void disconnect() {
        if (connection && connected) {
            try {
                client.close(connection, websocketpp::close::status::normal, "");
            } catch (...) {}
        }
        
        connected = false;
        
        if (clientThread.joinable()) {
            try {
                client.stop();
                clientThread.join();
            } catch (...) {}
        }
    }
    
    bool isConnected() const {
        return connected;
    }
    
    ~WebSocketClient() {
        disconnect();
        if (logFile.is_open()) {
            logFile.close();
        }
    }

private:
    std::string getCurrentTimestamp() {
        auto now = std::chrono::system_clock::now();
        auto now_time_t = std::chrono::system_clock::to_time_t(now);
        std::stringstream ss;
        ss << std::put_time(std::localtime(&now_time_t), "%Y%m%d_%H%M%S");
        return ss.str();
    }

    void logMessage(const std::string& message, const std::string& prefix = "SERVER") {
        if (!logFile.is_open()) return;
        
        auto now = std::chrono::system_clock::now();
        auto now_time_t = std::chrono::system_clock::to_time_t(now);
        
        logFile << "[" << std::put_time(std::localtime(&now_time_t), "%Y-%m-%d %H:%M:%S") 
                << "] " << prefix << ": " << message << std::endl;
        logFile.flush();
    }

    Client client;
    Client::connection_ptr connection;
    std::thread clientThread;
    bool connected = false;
    bool connectionFailed = false;
    std::string deviceId;
    std::ofstream logFile;
    std::string logFilePath;
    std::unique_ptr<TTSClient> ttsClient;
};

int main(int argc, char** argv) {
    // Get server URL from environment or use default
    const std::string wsUrl = getEnv("WS_URL", "wss://robot-api1.pvi.digital");
    
    std::cout << "🎤 Starting WebSocket client\n"
              << "Server: " << wsUrl << "\n"
              << "Audio device: plughw:6,0\n\n";
    
    WebSocketClient wsClient;
    
    while (true) {
        try {
            if (!wsClient.isConnected()) {
                std::cout << "🔄 Attempting to connect to WebSocket server...\n";
                if (!wsClient.tryConnect(wsUrl)) {
                    std::cerr << "❌ Connection failed. Retrying in 5 seconds...\n";
                    std::this_thread::sleep_for(5s);
                    continue;
                }
            }
            
            // Just sleep to keep the program running
            std::this_thread::sleep_for(1s);
            
        } catch (const std::exception& e) {
            std::cerr << "Error in main loop: " << e.what() << "\n";
            std::this_thread::sleep_for(1s);
        }
    }
    
    return 0;
} 