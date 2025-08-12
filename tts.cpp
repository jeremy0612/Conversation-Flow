#include <curl/curl.h>
#include <iostream>
#include <string>
#include <vector>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <thread>
#include <chrono>
#include <cstring>

using namespace std::chrono_literals;

// Helper function to get environment variables
static std::string getEnv(const char* key, const std::string& def = "") {
    const char* v = std::getenv(key);
    return v ? std::string(v) : def;
}

// Callback function to write received data to a vector
static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t realsize = size * nmemb;
    auto* vec = static_cast<std::vector<char>*>(userp);
    
    // Get the current position
    size_t currentSize = vec->size();
    
    // Resize the vector to accommodate new data
    vec->resize(currentSize + realsize);
    
    // Copy the new data
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
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L); // Skip SSL verification
        
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
            // Play audio using aplay
            std::string playCmd = "aplay -D plughw:6,0 '" + audioFile + "'";
            std::cout << "🎵 Playing audio: " << playCmd << std::endl;
            
            int result = system(playCmd.c_str());
            if (result != 0) {
                std::cerr << "❌ Failed to play audio, aplay returned: " 
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

void printUsage(const char* programName) {
    std::cout << "Usage: " << programName << " \"text to speak\"" << std::endl;
    std::cout << "Example: " << programName << " \"Xin chào\"" << std::endl;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        printUsage(argv[0]);
        return 1;
    }
    
    try {
        TTSClient ttsClient;
        std::string text = argv[1];
        
        // Create temporary file for audio
        std::string tempFile = "/tmp/tts_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()) + ".wav";
        
        // Get TTS audio
        if (!ttsClient.textToSpeech(text, tempFile)) {
            std::cerr << "❌ Failed to get TTS audio" << std::endl;
            return 1;
        }
        
        // Play the audio
        if (!ttsClient.playAudio(tempFile)) {
            std::cerr << "❌ Failed to play audio" << std::endl;
            return 1;
        }
        
        // Clean up temp file
        std::filesystem::remove(tempFile);
        
    } catch (const std::exception& e) {
        std::cerr << "❌ Error: " << e.what() << std::endl;
        return 1;
    }
    
    return 0;
} 