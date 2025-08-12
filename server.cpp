#include <websocketpp/config/asio_no_tls.hpp>
#include <websocketpp/server.hpp>
#include <iostream>
#include <fstream>
#include <ctime>
#include <filesystem>
#include <chrono>
#include <set>

using Server = websocketpp::server<websocketpp::config::asio>;
using ConnectionHdl = websocketpp::connection_hdl;
using Message = Server::message_ptr;

class AudioServer {
public:
    AudioServer() {
        // Set up server
        server.set_access_channels(websocketpp::log::alevel::none);
        server.set_error_channels(websocketpp::log::elevel::fatal);
        
        server.init_asio();
        
        // Register handlers
        server.set_message_handler([this](ConnectionHdl hdl, Message msg) {
            handle_message(hdl, msg);
        });
        
        server.set_open_handler([this](ConnectionHdl hdl) {
            std::cout << "Client connected\n";
            connections.insert(hdl);
        });
        
        server.set_close_handler([this](ConnectionHdl hdl) {
            std::cout << "Client disconnected\n";
            connections.erase(hdl);
        });

        // Ensure output directory exists
        std::filesystem::create_directories("output_test");
    }
    
    void run(uint16_t port) {
        server.listen(port);
        server.start_accept();
        std::cout << "WebSocket server listening on port " << port << std::endl;
        server.run();
    }

private:
    void handle_message(ConnectionHdl hdl, Message msg) {
        if (msg->get_opcode() == websocketpp::frame::opcode::binary) {
            auto now = std::chrono::system_clock::now();
            auto time = std::chrono::system_clock::to_time_t(now);
            std::tm tm;
            localtime_r(&time, &tm);
            
            char filename[64];
            std::strftime(filename, sizeof(filename), "output_test/rec_%Y%m%d_%H%M%S.wav", &tm);
            
            std::ofstream file(filename, std::ios::binary);
            if (file) {
                const auto& payload = msg->get_payload();
                file.write(payload.data(), payload.size());
                file.close();
                std::cout << "Saved audio to: " << filename << " (" << payload.size() << " bytes)\n";
            } else {
                std::cerr << "Failed to save audio to: " << filename << std::endl;
            }
        }
    }

    Server server;
    std::set<ConnectionHdl, std::owner_less<ConnectionHdl>> connections;
};

int main(int argc, char* argv[]) {
    try {
        uint16_t port = 9002; // Default port
        if (argc > 1) {
            port = static_cast<uint16_t>(std::stoi(argv[1]));
        }
        
        AudioServer server;
        server.run(port);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    } catch (websocketpp::lib::error_code e) {
        std::cerr << "Error: " << e.message() << std::endl;
        return 1;
    } catch (...) {
        std::cerr << "Unknown error" << std::endl;
        return 1;
    }
    
    return 0;
} 