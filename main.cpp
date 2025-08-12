#include <websocketpp/client.hpp>
#include <websocketpp/config/asio_client.hpp>  // Changed to support TLS
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <random>
#include <iomanip>
#include <chrono>

using namespace std::chrono_literals;

// Define WebSocket client types for secure connections
using Client = websocketpp::client<websocketpp::config::asio_tls_client>;
using ConnectionHdl = websocketpp::connection_hdl;
using ErrorCode = websocketpp::lib::error_code;

static std::string getEnv(const char* key, const std::string& def = "") {
    const char* v = std::getenv(key);
    return v ? std::string(v) : def;
}

static std::string generateClientId() {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dis(0, 15);
    
    std::stringstream ss;
    for(int i = 0; i < 8; i++) {
        ss << std::hex << dis(gen);
    }
    return ss.str();
}

static std::string getCurrentTimestamp() {
    auto now = std::chrono::system_clock::now();
    auto itt = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&itt), "%FT%T");
    return ss.str();
}

static std::string timestampedFilename() {
    std::time_t t = std::time(nullptr);
    std::tm tmStruct{};
    localtime_r(&t, &tmStruct);
    char buf[64];
    std::strftime(buf, sizeof(buf), "rec_%Y%m%d_%H%M%S.wav", &tmStruct);
    return std::string(buf);
}

// Read WAV file into binary buffer
static std::vector<char> readWavFile(const std::string& filename) {
    std::ifstream file(filename, std::ios::binary);
    if (!file) {
        throw std::runtime_error("Failed to open file: " + filename);
    }
    
    // Get file size
    file.seekg(0, std::ios::end);
    std::streamsize size = file.tellg();
    file.seekg(0, std::ios::beg);
    
    // Read file content
    std::vector<char> buffer(size);
    if (!file.read(buffer.data(), size)) {
        throw std::runtime_error("Failed to read file: " + filename);
    }
    
    return buffer;
}

class AudioStreamer {
public:
    AudioStreamer() {
        // Generate client ID
        clientId = generateClientId();
        
        // Set up WebSocket client
        client.clear_access_channels(websocketpp::log::alevel::all);
        client.clear_error_channels(websocketpp::log::elevel::all);
        
        client.init_asio();
        
        // Configure TLS
        client.set_tls_init_handler([](websocketpp::connection_hdl) {
            auto ctx = std::make_shared<boost::asio::ssl::context>(boost::asio::ssl::context::sslv23);
            ctx->set_options(boost::asio::ssl::context::default_workarounds |
                           boost::asio::ssl::context::no_sslv2 |
                           boost::asio::ssl::context::no_sslv3 |
                           boost::asio::ssl::context::single_dh_use);
            ctx->set_verify_mode(boost::asio::ssl::verify_none); // Skip certificate verification for ngrok
            return ctx;
        });
        
        // Register handlers
        client.set_message_handler([this](ConnectionHdl hdl, Client::message_ptr msg) {
            handleServerMessage(msg->get_payload());
        });
        
        client.set_open_handler([this](ConnectionHdl hdl) {
            std::cout << "WebSocket connection established" << std::endl;
            connected = true;
            connectionFailed = false;
            
            // Send initial configuration
            sendConfig();
        });
        
        client.set_close_handler([this](ConnectionHdl hdl) {
            std::cout << "WebSocket connection closed" << std::endl;
            connected = false;
        });
        
        client.set_fail_handler([this](ConnectionHdl hdl) {
            auto con = client.get_con_from_hdl(hdl);
            std::cout << "WebSocket connection failed. Error: " 
                      << con->get_ec().message() << std::endl;
            connected = false;
            connectionFailed = true;
        });
    }
    
    bool tryConnect(const std::string& baseUrl) {
        try {
            // Construct the full URL with client ID
            std::string fullUrl = baseUrl + "/api/asr-batch-stream/ws/" + clientId;
            std::cout << "Connecting to: " << fullUrl << std::endl;
            
            websocketpp::lib::error_code ec;
            connection = client.get_connection(fullUrl, ec);
            if (ec) {
                std::cerr << "Failed to create connection: " << ec.message() << std::endl;
                return false;
            }
            
            client.connect(connection);
            
            // Start the ASIO io_service run loop in a separate thread
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
            
            // Wait a bit to see if connection succeeds
            for (int i = 0; i < 10 && !connected && !connectionFailed; ++i) {
                std::this_thread::sleep_for(100ms);
            }
            
            return connected;
        } catch (const std::exception& e) {
            std::cerr << "Connection attempt failed: " << e.what() << std::endl;
            return false;
        }
    }
    
    void sendConfig() {
        if (!connected) return;
        
        std::stringstream ss;
        ss << "{"
           << "\"type\":\"config\","
           << "\"config\":{"
           << "\"audio_format\":\"pcm16\","
           << "\"sample_rate\":16000,"
           << "\"channels\":1,"
           << "\"chunk_size\":1024"
           << "}}";
        
        websocketpp::lib::error_code ec;
        client.send(connection, ss.str(), websocketpp::frame::opcode::text, ec);
        if (ec) {
            std::cerr << "Failed to send config: " << ec.message() << std::endl;
        } else {
            std::cout << "Configuration sent to server" << std::endl;
        }
    }
    
    void handleServerMessage(const std::string& message) {
        std::cout << "Received from server: " << message << std::endl;
    }
    
    void disconnect() {
        if (connection && connected) {
            try {
                client.close(connection, websocketpp::close::status::normal, "");
            } catch (...) {
                // Ignore errors during shutdown
            }
        }
        
        connected = false;
        
        if (clientThread.joinable()) {
            try {
                client.stop();
                clientThread.join();
            } catch (...) {
                // Ignore errors during shutdown
            }
        }
    }
    
    bool isConnected() const {
        return connected;
    }
    
    void sendAudioData(const std::vector<char>& data) {
        if (!connected) {
            throw std::runtime_error("WebSocket not connected");
        }
        
        // Create a JSON message with base64-encoded audio data
        std::string base64Data = websocketpp::base64_encode(
            reinterpret_cast<const unsigned char*>(data.data()), 
            data.size()
        );
        
        // Create the JSON message with timestamp
        std::stringstream ss;
        ss << "{"
           << "\"type\":\"audio\","
           << "\"data\":\"" << base64Data << "\","
           << "\"timestamp\":\"" << getCurrentTimestamp() << "\","
           << "\"client_id\":\"" << clientId << "\""
           << "}";
        
        websocketpp::lib::error_code ec;
        client.send(connection, ss.str(), websocketpp::frame::opcode::text, ec);
        if (ec) {
            throw std::runtime_error("Failed to send data: " + ec.message());
        }
    }
    
    ~AudioStreamer() {
        disconnect();
    }

private:
    Client client;
    Client::connection_ptr connection;
    std::thread clientThread;
    bool connected = false;
    bool connectionFailed = false;
    std::string clientId;
};

int main(int argc, char** argv) {
    const std::string device = getEnv("ARECORD_DEVICE", "hw:5,0");
    const std::string duration = "2"; // Fixed 2-second duration
    const std::string format = getEnv("ARECORD_FORMAT", "S16_LE");
    const std::string rate = getEnv("ARECORD_RATE", "16000");
    
    // WebSocket endpoint (default to local server)
    const std::string wsUrl = getEnv("WS_URL", "wss://robot-asr.pvi.digital");
    
    AudioStreamer streamer;
    
    std::cout << "Starting audio recording and streaming service\n"
              << "Device: " << device << "\n"
              << "Format: " << format << "\n"
              << "Rate: " << rate << "\n"
              << "Duration: " << duration << "s\n"
              << "Server: " << wsUrl << "\n\n";
    
    while (true) {
        try {
            if (!streamer.isConnected()) {
                std::cout << "Attempting to connect to WebSocket server...\n";
                if (!streamer.tryConnect(wsUrl)) {
                    std::cerr << "Connection failed. Retrying in 5 seconds...\n";
                    std::this_thread::sleep_for(5s);
                    continue;
                }
            }
            
            const std::string filename = timestampedFilename();
            
            std::ostringstream recCmd;
            recCmd << "arecord -D " << device
                   << " -d " << duration
                   << " -f " << format
                   << " -r " << rate
                   << " '" << filename << "'";
            
            std::cout << "Recording: " << recCmd.str() << "\n";
            int recStatus = std::system(recCmd.str().c_str());
            if (recStatus != 0) {
                std::cerr << "arecord failed with status " << recStatus << ". Retrying...\n";
                std::this_thread::sleep_for(1s);
                continue;
            }
            
            if (!std::filesystem::exists(filename)) {
                std::cerr << "No output file produced: " << filename << ". Retrying...\n";
                std::this_thread::sleep_for(1s);
                continue;
            }
            
            try {
                // Read and send the WAV file
                auto audioData = readWavFile(filename);
                streamer.sendAudioData(audioData);
                std::cout << "Sent " << audioData.size() << " bytes of audio data\n";
                
                // Clean up the file
                std::error_code ec;
                std::filesystem::remove(filename, ec);
                if (ec) {
                    std::cerr << "Warning: could not remove file '" << filename << "': " << ec.message() << "\n";
                }
            } catch (const std::exception& e) {
                std::cerr << "Error sending audio data: " << e.what() << "\n";
                // Keep the file for inspection on error
                std::cerr << "Keeping file for inspection: " << filename << "\n";
                // Reset connection on send error
                streamer.disconnect();
            }
        } catch (const std::exception& e) {
            std::cerr << "Error in main loop: " << e.what() << "\n";
            std::this_thread::sleep_for(1s);
        }
    }
    
    return 0;
} 