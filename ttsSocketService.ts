import {Alert} from 'react-native';
import {io, Socket} from 'socket.io-client';
import {NavigationProp} from '@react-navigation/native';
import {
  navigateByLink,
  isValidLink,
  LINK_TO_SCREEN_MAP,
} from '../services/linkNavigationService';
import {convertBase64ToAudio} from '../Speech/convert-audio';
const RNFS = require('react-native-fs');
const Sound = require('react-native-sound');
import DeviceInfo from 'react-native-device-info';
import {audioController} from './AudioController';
import {notificationService} from './NotificationService';
import {audioStreamingService} from './audioStreamingService';

interface TTSMessage {
  type: string;
  data?: any;
  message?: string;
  timestamp?: string;
  [key: string]: any;
}

interface SentenceAudioMessage {
  audioData: string; // base64 string
  timestamp?: string;
  sessionId?: string;
  sentenceIndex?: number;
  contentType?: string;
  sentence?: string;
}

interface AudioStopData {
  reason: string;
  priority: 'low' | 'normal' | 'high';
  forceStop: boolean;
  message?: string;
  timestamp?: string;
}

export default class TTSSocketClient {
  private socket: Socket | null = null;
  private isConnected = false;
  private isConnecting = false; // Add connection state tracking
  private deviceId: string = ''; // Device ID for server tracking

  // Config kết nối
  // private serverUrl: string = 'http://192.168.203.120:9000/tts';
  private serverUrl: string = 'https://robot-api1.pvi.digital/tts';
  private maxReconnectAttempts = 15; // Increased from 10 to 15 for less aggressive retries
  private reconnectDelay = 2000; // Base delay increased to 2 seconds for less aggressive retries
  private reconnectAttempts = 0; // Track current retry attempt
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null; // Track retry timer
  private isReconnecting = false; // Track if we're in reconnection mode

  // Event handlers
  private onConnectedHandler?: () => void;
  private onDisconnectedHandler?: (reason: string) => void;
  private onMessageHandler?: (msg: TTSMessage) => void;
  private onErrorHandler?: (err: any) => void;
  private onNavigationHandler?: (link: string) => void;
  private onSentenceHandler?: (
    sentence: string,
    meta?: SentenceAudioMessage,
  ) => void;
  private onUserSentenceHandler?: (
    sentence: string,
    meta?: SentenceAudioMessage,
  ) => void;

  // Navigation reference for direct navigation
  private navigationRef?: NavigationProp<any>;

  // Audio player
  private isPlayingAudio = false;
  private currentSound: any = null;
  private playbackQueue: string[] = [];
  private isDequeuing = false;

  // Thêm state cho queue information
  private currentQueueData: {
    queueNumber?: string;
    counterNumber?: string;
  } | null = null;

  constructor(serverUrl?: string) {
    if (serverUrl) {
      this.serverUrl = serverUrl;
    }

    // Initialize device ID
    this.initializeDeviceId();

    console.log('🎯 TTS Socket.IO Client initialized:', this.serverUrl);

    // Initialize Sound category
    try {
      Sound.setCategory('Playback');
    } catch (error) {
      console.error('❌ Error setting sound category:', error);
    }
  }

  private async initializeDeviceId(): Promise<void> {
    try {
      // Get device unique identifier
      const deviceId = await DeviceInfo.getUniqueId();
      this.deviceId = deviceId;
      console.log('📱 Device ID set for TTS client:', deviceId);
    } catch (error) {
      // Fallback to random string if device ID is not available
      this.deviceId = Math.random().toString(36).substring(2, 10);
      console.warn(
        '⚠️ Failed to get device ID for TTS, using random ID:',
        this.deviceId,
      );
    }
  }

  async connect(): Promise<boolean> {
    // Ensure device ID is initialized before connecting
    if (!this.deviceId) {
      await this.initializeDeviceId();
    }

    // Prevent multiple simultaneous connections
    if (this.socket && this.isConnected) {
      console.log('✅ Already connected to server');
      return true;
    }

    if (this.isConnecting) {
      console.log('⏳ Connection already in progress...');
      return false;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.socket = io(this.serverUrl, {
          transports: ['websocket'],
          reconnection: true,
          reconnectionAttempts: this.maxReconnectAttempts,
          reconnectionDelay: this.reconnectDelay,
          extraHeaders: {
            'ngrok-skip-browser-warning': 'true',
            'User-Agent': 'ReactNative-SocketIO',
          },
          // Add network configuration to prevent ClassCastException
          forceNew: true,
          timeout: 20000,
          // Send device ID as auth data
          auth: {
            deviceId: this.deviceId,
          },
        });

        // Khi kết nối thành công
        this.socket.on('connect', () => {
          this.isConnected = true;
          this.isConnecting = false;
          this.isReconnecting = false; // Stop retry attempts
          this.clearReconnectTimer(); // Clear any pending retry
          this.reconnectAttempts = 0; // Reset retry counter
          console.log('✅ Connected to TTS Socket.IO server');
          console.log('📡 Server URL:', this.serverUrl);
          console.log('🔗 Socket ID:', this.socket?.id);
          console.log('📱 Device ID:', this.deviceId);

          // Show connection notification
          notificationService.showConnectionNotification(true);

          this.onConnectedHandler?.();
          this.sendPing();
          resolve(true);
        });

        // Khi nhận event do server emit
        this.socket.on('tts_data', (data: any) => {
          console.log('🔊 =========================');
          console.log('🔊 Received TTS_DATA from server:');
          console.log('🔊 Raw data:', JSON.stringify(data, null, 2));
          // Alert.alert('TTS_DATA', JSON.stringify(data, null, 2));
          console.log('🔊 Data type:', typeof data);
          console.log('🔊 Timestamp:', new Date().toISOString());
          console.log('🔊 =========================');

          const msg: TTSMessage = {
            type: 'tts_data',
            data,
            timestamp: new Date().toISOString(),
          };
          this.onMessageHandler?.(msg);
        });

        this.socket.on('tts_status', (message: string) => {
          // console.log('📊 =========================');
          // console.log('📊 Received TTS_STATUS from server:');
          // console.log('📊 Status message:', message);
          // console.log('📊 Message type:', typeof message);
          // console.log('📊 Timestamp:', new Date().toISOString());
          // Alert.alert('TTS_STATUS', message);
          // console.log('📊 =========================');

          const msg: TTSMessage = {
            type: 'tts_status',
            message,
            timestamp: new Date().toISOString(),
          };
          this.onMessageHandler?.(msg);
        });
        this.socket.on(
          'sentence_audio',
          async (message: SentenceAudioMessage) => {
            console.log('🔊 =========================');
            console.log('🔊 Received sentence_audio from server');
            console.log('🔊 Audio data type:', typeof message.audioData);
            console.log('🔊 Sentence:', message.sentence);
            console.log('🔊 =========================');

            try {
              await this.handleAudioMessage(message);
            } catch (error) {
              console.error('❌ Error handling audio message:', error);
            }
          },
        );

        // Listen for user-side sentence (no audio playback, only typing animation)
        this.socket.on('sentence_user', (message: SentenceAudioMessage) => {
          console.log(message);
          console.log('💬 =========================');
          console.log('💬 Received sentence_user from server');
          console.log('💬 Sentence:', message?.sentence);
          console.log('💬 =========================');

          try {
            if (message?.sentence) {
              this.onUserSentenceHandler?.(message.sentence, message);
            }
          } catch (error) {
            console.error('❌ Error emitting user sentence:', error);
          }
        });

        // Lắng nghe audio stop signal từ server
        this.socket.on('audio_stop', (data: AudioStopData) => {
          console.log('🛑 =========================');
          console.log('🛑 Received audio_stop from server:');
          console.log('🛑 Data:', JSON.stringify(data, null, 2));
          console.log('🛑 =========================');

          // Xử lý audio stop signal
          this.handleAudioStopSignal(data);
        });
        // {
        //   type: 'queue_assigned', // Loại sự kiện
        //     queueNumber, // Số thứ tự vừa cấp, ví dụ: 15
        //     counter, // Mã quầy phục vụ, ví dụ: "A"
        //     service, // Mã dịch vụ, ví dụ: "cap_lai_cccd"
        //     qrCode, // Chuỗi JSON chứa thông tin số thứ tự, quầy, dịch vụ, thời gian dự kiến
        //     message, // Thông báo dạng text cho TTS đọc, ví dụ: "Số thứ tự của quý vị là mười lăm..."
        //     timestamp; // Thời điểm tạo sự kiện, ISO string
        // }

        this.socket.on('queue_assigned', (message: any) => {
          console.log('🔊 =========================');
          // console.log('🔊 Received queue_assigned from server');
          console.log('🔊 Message:', message);
          console.log('🔊 =========================');
          // console.log('🔊 Queue number:', message.queueNumber);
          // console.log('🔊 Counter:', message.counter);
          // console.log('🔊 Service:', message.service);
          // console.log('🔊 QR code:', String(message.qrCode));
          // console.log('🔊 Message:', message.message);
          // console.log('🔊 Timestamp:', message.timestamp);
          // console.log('🔊 =========================');

          // Lưu queue information để sử dụng khi navigate
          this.currentQueueData = {
            queueNumber: message.queueNumber,
            counterNumber: message.counter,
          };
        });

        // Listen for navigation events from server
        this.socket.on('navigation', (data: any) => {
          console.log('🧭 Received NAVIGATION from server:', data);

          // Extract link from data
          let link: string = '';
          if (typeof data === 'string') {
            link = data;
          } else if (data && typeof data === 'object') {
            // Try common property names for navigation link
            link = data.url || data.link || data.navigation || '';
          }

          console.log('🔍 Extracted link:', link);
          console.log('🔍 Link is valid:', isValidLink(link));

          if (link && isValidLink(link)) {
            console.log('🧭 Navigating to:', link);

            // Sử dụng currentQueueData đã lưu từ queue_assigned event
            const success = navigateByLink(
              null,
              link,
              this.currentQueueData || undefined,
            );

            if (success) {
              console.log('✅ Navigation successful:', link);
              // Clear queue data sau khi navigate thành công
              this.currentQueueData = null;
            } else {
              console.error('❌ Navigation failed:', link);
              // Fallback to handler
              this.onNavigationHandler?.(link);
            }
          } else {
            console.error('❌ Invalid navigation link:', link);
            console.error(
              '❌ Available links:',
              Object.keys(LINK_TO_SCREEN_MAP),
            );
          }
        });

        // Listen for any custom events from server
        this.socket.onAny((eventName: string, ...args: any[]) => {
          // console.log('🌟 =========================');
          // console.log('🌟 Received ANY EVENT from server:');
          // console.log('🌟 Event name:', eventName);
          // // console.log('🌟 Arguments:', JSON.stringify(args, null, 2));
          // console.log('🌟 Args count:', args.length);
          // console.log('🌟 Timestamp:', new Date().toISOString());
          // // Alert.alert('ANY EVENT', eventName);
          // console.log('🌟 =========================');
        });

        // Listen for pong responses
        this.socket.on('pong', (data: any) => {
          console.log('🏓 =========================');
          // console.log('🏓 Received PONG from server:');
          // console.log('🏓 Pong data:', JSON.stringify(data, null, 2));
          // console.log('🏓 Timestamp:', new Date().toISOString());
          // console.log('🏓 =========================');
        });

        // Custom error event
        this.socket.on('error', (err: any) => {
          this.isConnecting = false;
          console.error('❌ =========================');
          console.error('❌ Socket.IO ERROR:');
          console.error('❌ Error details:', JSON.stringify(err, null, 2));
          console.error('❌ Error type:', typeof err);
          console.error('❌ Timestamp:', new Date().toISOString());
          console.error('❌ =========================');
          this.onErrorHandler?.(err);
          reject(err);
        });

        // Khi disconnect (có thể do server hoặc network)
        this.socket.on('disconnect', (reason: string) => {
          this.isConnected = false;
          this.isConnecting = false;
          console.log('🔌 =========================');
          console.log('🔌 DISCONNECTED from server:');
          console.log('🔌 Reason:', reason);
          console.log('🔌 Previous connection status:', this.isConnected);
          console.log('🔌 Timestamp:', new Date().toISOString());
          console.log('🔌 =========================');

          // Show disconnection notification
          notificationService.showConnectionNotification(false);

          // Start Discord-inspired retry logic
          if (!this.isReconnecting) {
            this.isReconnecting = true;
            this.scheduleReconnect();
          }

          this.onDisconnectedHandler?.(reason);
        });

        // Connection timeout
        setTimeout(() => {
          if (!this.isConnected && this.isConnecting) {
            this.isConnecting = false;
            console.error('⏰ Connection timeout after 20 seconds');
            reject(new Error('Connection timeout'));
          }
        }, 20000); // Increased timeout to 20 seconds

        // Handle connection errors
        this.socket.on('connect_error', (error: any) => {
          this.isConnecting = false;
          console.error('❌ Connection error:', JSON.stringify(error));
          reject(error);
        });
      } catch (error) {
        this.isConnecting = false;
        console.error('❌ Failed to create socket connection:', error);
        reject(error);
      }
    });
  }

  // Gửi ping (nếu bạn custom event 'ping' trên server)
  sendPing() {
    if (this.socket && this.isConnected) {
      const pingData = {
        timestamp: new Date().toISOString(),
        deviceId: this.deviceId,
      };
      this.socket.emit('ping', pingData);
      console.log('🏓 Sent ping to server:', JSON.stringify(pingData, null, 2));
    }
  }

  // Discord-inspired retry logic
  private calculateRetryDelay(attempt: number): number {
    // Start with 2-second intervals for first 3 attempts (less aggressive)
    if (attempt <= 3) {
      const initialDelays = [2000, 2000, 2000]; // 2 seconds for first 3 attempts
      return initialDelays[attempt - 1] || 2000;
    }

    // Exponential backoff for attempts 4-15
    const baseDelay = this.reconnectDelay * Math.pow(2, attempt - 4);

    // Add jitter (±15% randomness like Discord)
    const jitter = 0.15;
    const randomFactor = 1 + (Math.random() * 2 - 1) * jitter;

    // Cap maximum delay at 3 minutes (180 seconds)
    const maxDelay = 180000;
    const delay = Math.min(baseDelay * randomFactor, maxDelay);

    return Math.round(delay);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('🔄 Max reconnection attempts reached, giving up');
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateRetryDelay(this.reconnectAttempts);

    console.log(
      `🔄 Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      if (this.isReconnecting) {
        try {
          console.log(
            `🔄 Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
          );
          await this.connect();
          // Reset on successful connection
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
        } catch (error) {
          console.error(
            `❌ Reconnection attempt ${this.reconnectAttempts} failed:`,
            error,
          );
          // Schedule next attempt
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Gửi request TTS
  sendTTSRequest(text: string, options?: any) {
    if (this.socket && this.isConnected) {
      const requestData = {
        text,
        deviceId: this.deviceId,
        ...options,
        timestamp: new Date().toISOString(),
      };
      this.socket.emit('tts_request', requestData);
      console.log('📤 =========================');
      console.log('📤 Sent TTS_REQUEST to server:');
      console.log('📤 Request data:', JSON.stringify(requestData, null, 2));
      console.log('📤 Text length:', text.length);
      console.log('📤 Options:', JSON.stringify(options, null, 2));
      console.log('📤 Timestamp:', new Date().toISOString());
      console.log('📤 =========================');
    } else {
      console.warn('❌ Cannot send TTS request - not connected to server');
      console.warn('❌ Connection status:', this.isConnected);
      console.warn('❌ Socket exists:', !!this.socket);
    }
  }

  // Gửi navigation request đến server (nếu cần)
  sendNavigationRequest(link: string, options?: any) {
    if (this.socket && this.isConnected) {
      const requestData = {
        link,
        deviceId: this.deviceId,
        ...options,
        timestamp: new Date().toISOString(),
      };
      this.socket.emit('navigation_request', requestData);
      console.log('🧭 =========================');
      console.log('🧭 Sent NAVIGATION_REQUEST to server:');
      console.log('🧭 Request data:', JSON.stringify(requestData, null, 2));
      console.log('🧭 Link:', link);
      console.log('🧭 Options:', JSON.stringify(options, null, 2));
      console.log('🧭 Timestamp:', new Date().toISOString());
      console.log('🧭 =========================');
    } else {
      console.warn(
        '❌ Cannot send navigation request - not connected to server',
      );
      console.warn('❌ Connection status:', this.isConnected);
      console.warn('❌ Socket exists:', !!this.socket);
    }
  }

  disconnect() {
    if (this.socket) {
      console.log('🧹 Manually disconnecting from server...');
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.isConnecting = false;
      this.isReconnecting = false; // Stop retry attempts
      this.clearReconnectTimer(); // Clear any pending retry
      this.reconnectAttempts = 0; // Reset retry counter
      console.log('🧹 Successfully disconnected');
    }
  }

  // Setters for external handlers
  onConnected(fn: () => void) {
    this.onConnectedHandler = fn;
  }
  onDisconnected(fn: (reason: string) => void) {
    this.onDisconnectedHandler = fn;
  }
  onMessage(fn: (msg: TTSMessage) => void) {
    this.onMessageHandler = fn;
  }
  onError(fn: (err: any) => void) {
    this.onErrorHandler = fn;
  }
  onNavigation(fn: (link: string) => void) {
    this.onNavigationHandler = fn;
  }

  // Subscribe to robot sentence text (for typing animation in UI)
  onSentence(fn: (sentence: string, meta?: SentenceAudioMessage) => void) {
    this.onSentenceHandler = fn;
  }

  // Subscribe to user sentence text (for typing animation on user side)
  onUserSentence(fn: (sentence: string, meta?: SentenceAudioMessage) => void) {
    this.onUserSentenceHandler = fn;
  }

  // Set navigation reference for direct navigation
  setNavigationRef(navigation: NavigationProp<any>) {
    this.navigationRef = navigation;
    console.log('🧭 Navigation reference set for direct navigation');
  }

  // Clear navigation reference
  clearNavigationRef() {
    this.navigationRef = undefined;
    console.log('🧭 Navigation reference cleared');
  }

  getIsConnected() {
    return this.isConnected;
  }

  getServerUrl() {
    return this.serverUrl;
  }

  getDeviceId() {
    return this.deviceId;
  }

  setServerUrl(url: string) {
    this.serverUrl = url;
  }

  // Method to update server URL and reconnect
  async updateServerUrl(newUrl: string) {
    const wasConnected = this.isConnected;
    console.log('🔄 Updating server URL from', this.serverUrl, 'to', newUrl);

    if (wasConnected) {
      console.log('🔄 Disconnecting from current server...');
      this.disconnect();
    }

    this.setServerUrl(newUrl);

    if (wasConnected) {
      setTimeout(async () => {
        try {
          console.log('🔄 Attempting to reconnect to new server...');
          await this.connect();
          console.log('🔄 Successfully reconnected to new server');
        } catch (error) {
          console.error('❌ Failed to reconnect after URL update:', error);
        }
      }, 1000);
    }
  }

  // Audio handling methods
  private async handleAudioMessage(
    message: SentenceAudioMessage,
  ): Promise<void> {
    try {
      // Emit sentence text for UI typing animation as soon as we receive it
      if (message?.sentence) {
        try {
          this.onSentenceHandler?.(message.sentence, message);
        } catch (cbErr) {
          console.warn('⚠️ onSentence handler error:', cbErr);
        }
      }
      // Prepare audio data for conversion
      const audioData = {
        originalData: message.audioData,
        timestamp: message.timestamp || new Date().toISOString(),
        sessionId: message.sessionId || 'unknown',
        sentenceIndex: message.sentenceIndex || 0,
        contentType: message.contentType || 'audio/wav',
        sentence: message.sentence || 'Unknown sentence',
      };

      console.log('🎵 Converting base64 to audio file...');
      const audioFilePath = await convertBase64ToAudio(audioData);

      // Giữ nguyên queue system hiện tại để đảm bảo luồng hoạt động
      this.enqueueAudioFile(audioFilePath);
      this.startNextIfIdle();

      console.log('✅ Audio queued successfully via original queue system');
    } catch (error) {
      console.error('❌ Error handling audio message:', error);
    }
  }

  private enqueueAudioFile(filePath: string): void {
    this.playbackQueue.push(filePath);
  }

  private async startNextIfIdle(): Promise<void> {
    if (this.isDequeuing || this.isPlayingAudio) {
      return;
    }
    this.isDequeuing = true;
    try {
      while (this.playbackQueue.length > 0) {
        const nextPath = this.playbackQueue.shift();
        if (!nextPath) {
          continue;
        }
        try {
          await this.playAudio(nextPath);
        } finally {
          // Delete file after playback attempt to free storage
          await this.deleteFileSafe(nextPath);
        }
      }
    } finally {
      this.isDequeuing = false;
    }
  }

  private async deleteFileSafe(filePath: string): Promise<void> {
    try {
      const exists = await RNFS.exists(filePath);
      if (exists) {
        await RNFS.unlink(filePath);
        console.log('🧹 Deleted audio file:', filePath);
      }
    } catch (error) {
      console.warn('⚠️ Failed to delete audio file:', filePath, error);
    }
  }

  private async playAudio(audioFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log('🎵 Attempting to play audio:', audioFilePath);

        // Stop and release current sound if any
        if (this.currentSound) {
          try {
            this.currentSound.stop(() => {
              this.currentSound?.release();
              this.currentSound = null;
            });
          } catch {}
        }

        // Stop mic before playing audio
        audioStreamingService.stop();

        const sound = new Sound(audioFilePath, '', (error: any) => {
          if (error) {
            console.error('❌ Failed to load audio file:', error);
            this.isPlayingAudio = false;
            // Restart mic if audio fails to load
            audioStreamingService.start();
            reject(error);
            return;
          }

          this.currentSound = sound;
          this.isPlayingAudio = true;

          sound.play((success: any) => {
            this.isPlayingAudio = false;

            // Release the sound resource
            try {
              sound.release();
            } catch (error) {
              console.warn('Warning: Error releasing sound:', error);
            }

            this.currentSound = null;

            // Restart mic after audio playback completes
            audioStreamingService.start();

            if (success) {
              console.log('✅ Audio playback completed successfully');
              resolve();
            } else {
              console.error('❌ Audio playback failed due to decoding errors');
              reject(new Error('Audio playback failed'));
            }
          });
        });
      } catch (error) {
        console.error('❌ Error playing audio:', error);
        this.isPlayingAudio = false;
        // Restart mic if there's an error
        audioStreamingService.start();
        reject(error);
      }
    });
  }

  private async stopAudio(): Promise<void> {
    return new Promise(resolve => {
      try {
        if (this.currentSound) {
          console.log('🛑 Stopping current audio playback');
          this.currentSound.stop(() => {
            this.currentSound?.release();
            this.currentSound = null;
            this.isPlayingAudio = false;
            resolve();
          });
        } else {
          this.isPlayingAudio = false;
          resolve();
        }
      } catch (error) {
        console.error('❌ Error stopping audio:', error);
        this.isPlayingAudio = false;
        resolve();
      }
    });
  }

  // Public method to check if audio is playing
  public isAudioPlaying(): boolean {
    return this.isPlayingAudio;
  }

  // Public method to stop audio
  public async stopCurrentAudio(): Promise<void> {
    await this.stopAudio();
    // Optional: clear queued items when stopping explicitly
    this.playbackQueue = [];
  }

  // Public method to resume audio
  public resumeAudio(): void {
    if (this.currentSound && !this.isPlayingAudio) {
      console.log('▶️ Resuming current audio...');
      try {
        this.currentSound.play();
        this.isPlayingAudio = true;
      } catch (error) {
        console.error('❌ Error resuming audio:', error);
      }
    }
  }

  // Handle audio stop signal from server
  private async handleAudioStopSignal(data: AudioStopData): Promise<void> {
    try {
      console.log('🛑 Processing audio stop signal from server:', data);

      const {reason, priority, forceStop, message} = data;

      // Xử lý dựa trên priority và forceStop
      if (forceStop || priority === 'high') {
        console.log('🚨 Force stopping all audio due to high priority signal');

        // Stop current audio
        await this.stopAudio();

        // Clear queue
        this.playbackQueue = [];

        // Stop dequeuing process
        this.isDequeuing = false;

        // Show notification
        notificationService.showAudioStopNotification(reason, priority);
      } else if (priority === 'normal') {
        console.log('⏸️ Normal priority - pausing current audio');

        // Pause current audio (stop but keep in queue)
        if (this.currentSound && this.isPlayingAudio) {
          this.currentSound.pause();
          this.isPlayingAudio = false;
        }
      } else {
        console.log('🛑 Standard stop - stopping current audio');

        // Stop current audio but keep queue
        await this.stopAudio();
      }

      console.log('✅ Audio stop signal processed successfully');
    } catch (error) {
      console.error('❌ Error processing audio stop signal:', error);
    }
  }
}

// Create singleton instance
export const ttsSocketClient = new TTSSocketClient();
('');
