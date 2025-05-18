import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

// Global variables for sound management
let isSoundPlaying = false;
let activeAudio = null;
let userStoppedSound = false;
let isAppJustLoaded = true;
let soundTimeout = null;

const API_URL = import.meta.env.VITE_API_URL;

function ShopliftingAlert() {
  const [isVisible, setIsVisible] = useState(false);
  const [alertData, setAlertData] = useState(null);
  const [mounted, setMounted] = useState(false);
  const [alertQueue, setAlertQueue] = useState([]);
  const [isDismissing, setIsDismissing] = useState(false);
  const [lastAlertId, setLastAlertId] = useState(null); // Track last alert to avoid duplicates
  const [lastAlertTime, setLastAlertTime] = useState(null); // Track time of last alert for throttling
  const [isPollingPaused, setIsPollingPaused] = useState(false); // Pause polling when user is viewing evidence
  const processedAlerts = useRef(new Set()); // Track all alerts we've processed to avoid duplicates
  const audioRef = useRef(null); // Reference to the audio element
  const navigate = useNavigate();

  const getAuthHeaders = () => {
    const token = localStorage.getItem('accessToken');
    if (!token) return null;
    
    return {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };
  };

  const checkForAlerts = async () => {
    // If polling is paused, skip this check
    if (isPollingPaused) return;
    
    const headers = getAuthHeaders();
    if (!headers) return;

    try {
      // Add a cache-busting parameter to prevent browser caching
      const cacheBuster = new Date().getTime();
      const response = await axios.get(
        `${API_URL}check-for-alerts/?t=${cacheBuster}`,
        headers
      );
      
      if (response.data.status === 'success') {
        const { unreviewed_count, latest_alert } = response.data;
        
        // Skip alert processing during the initial app load period
        if (isAppJustLoaded) {
          console.log("App just loaded, tracking alerts but not showing notifications");
          
          // Still track the alert IDs to avoid showing them later
          if (latest_alert) {
            processedAlerts.current.add(latest_alert.id);
            setLastAlertId(latest_alert.id);
          }
          
          return;
        }
        
        // Check if the camera associated with the alert is still active/connected
        if (latest_alert) {
          try {
            const cameraResponse = await axios.get(
              `${API_URL}check-camera-status/${latest_alert.camera_id}/`,
              headers
            );
            
            if (cameraResponse.data.status !== 'active') {
              console.log("Camera not active, ignoring alert:", latest_alert.id);
              processedAlerts.current.add(latest_alert.id);
              return;
            }
          } catch (error) {
            console.log("Camera not active or error checking camera status, ignoring alert");
            processedAlerts.current.add(latest_alert.id);
            return;
          }
        }
        
        // Process new alerts with throttling and better deduplication
        if (latest_alert && shouldProcessAlert(latest_alert)) {
          console.log("New alert detected:", latest_alert);
          processNewAlert(latest_alert, unreviewed_count);
          setLastAlertId(latest_alert.id);
          setLastAlertTime(Date.now());
          processedAlerts.current.add(latest_alert.id);
        }
      }
    } catch (error) {
      console.error('Error checking for alerts:', error);
      // Don't let one error stop future polling
    }
  };

  // Check if we should process an alert based on time throttling and deduplication
  const shouldProcessAlert = (alert) => {
    // If we've already processed this alert, skip it
    if (processedAlerts.current.has(alert.id)) {
      return false;
    }
    
    // If this is the same as the last alert we showed, skip it
    if (lastAlertId === alert.id) {
      return false;
    }
    
    // Check localStorage for processed alerts (marked as reviewed)
    try {
      const processedAlertsFromStorage = JSON.parse(localStorage.getItem('processedAlerts') || '[]');
      if (processedAlertsFromStorage.includes(alert.id)) {
        console.log("Alert already processed (from localStorage), skipping:", alert.id);
        // Add to our in-memory set to avoid future checks
        processedAlerts.current.add(alert.id);
        return false;
      }
    } catch (e) {
      console.error("Error checking processed alerts in localStorage:", e);
    }
    
    // Apply time-based throttling - don't show alerts too frequently
    // Only allow a new alert every 30 seconds at most
    if (lastAlertTime && (Date.now() - lastAlertTime < 30000)) {
      console.log("Throttling alert - too soon after previous alert");
      return false;
    }
    
    return true;
  };

  // Process a new alert and decide whether to show it immediately or queue it
  const processNewAlert = (newAlert, totalCount) => {
    // Skip showing alerts immediately after app load
    if (isAppJustLoaded) {
      console.log("App just loaded, skipping immediate alert display");
      return;
    }
    
    // Check if this alert is already in our queue or currently showing
    const isAlreadyQueued = alertQueue.some(a => a.id === newAlert.id);
    const isCurrentlyShowing = alertData && alertData.id === newAlert.id;
    
    if (!isAlreadyQueued && !isCurrentlyShowing) {
      if (!isVisible) {
        // If no alert is currently showing, show this one immediately
        setAlertData(newAlert);
        setIsVisible(true);
        // Reset the userStoppedSound flag for new alerts
        userStoppedSound = false;
        playAlertSound();
      } else {
        // Otherwise add it to the queue
        setAlertQueue(prevQueue => [...prevQueue, newAlert]);
      }
    }
  };

  // Play the alert sound - completely new implementation
  const playAlertSound = () => {
    // Clear any existing sound timeout
    if (soundTimeout) {
      clearTimeout(soundTimeout);
      soundTimeout = null;
    }

    // First stop any existing sounds
    forceStopAllAudio();
    
    // Don't start sound if user has manually stopped it
    if (userStoppedSound) {
      console.log("User has manually stopped sound - not restarting");
      return;
    }
    
    try {
      // Create a new audio element
      const audio = new Audio();
      audio.id = 'primary-alert-sound';
      audio.loop = true;
      
      // Set up event listeners
      audio.onended = () => {
        isSoundPlaying = false;
        activeAudio = null;
      };
      
      audio.onerror = (e) => {
        console.error("Audio error:", e);
        isSoundPlaying = false;
        activeAudio = null;
        
        if (!userStoppedSound) {
          tryAlternativeAudioMethod();
        }
      };
      
      // Add a cache-buster to prevent caching issues
      const cacheBuster = Date.now();
      audio.src = `/alert-sound.mp3?v=${cacheBuster}`;
      audio.load();
      
      // Try to play with a timeout
      const playPromise = audio.play();
      
      if (playPromise !== undefined) {
        playPromise.then(() => {
          console.log("Alert sound playing in loop mode");
          isSoundPlaying = true;
          activeAudio = audio;
          
          // Add to DOM for easier management
          document.body.appendChild(audio);
          
          // Set a timeout to stop the sound after 30 seconds if not dismissed
          soundTimeout = setTimeout(() => {
            if (isSoundPlaying && !userStoppedSound) {
              console.log("Stopping sound after timeout");
              forceStopAllAudio();
            }
          }, 30000); // 30 seconds timeout
        }).catch(e => {
          console.error("Error playing sound:", e);
          if (!userStoppedSound) {
            tryAlternativeAudioMethod();
          }
        });
      }
    } catch (e) {
      console.error("Error in playAlertSound:", e);
      if (!userStoppedSound) {
        tryAlternativeAudioMethod();
      }
    }
  };
  
  // Completely stop all audio to ensure nothing keeps playing
  const forceStopAllAudio = () => {
    try {
      console.log("Stopping all audio...");
      
      // Clear any pending sound timeout
      if (soundTimeout) {
        clearTimeout(soundTimeout);
        soundTimeout = null;
      }
      
      // Stop the active audio if exists
      if (activeAudio) {
        console.log("Stopping active audio element");
        activeAudio.pause();
        activeAudio.currentTime = 0;
        activeAudio.src = '';
        activeAudio.remove && activeAudio.remove();
        activeAudio = null;
      }
      
      // Reset the playing flag
      isSoundPlaying = false;
      
      // Additional global cleanup
      const allAudio = document.querySelectorAll('audio');
      allAudio.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = '';
          audio.remove && audio.remove();
        } catch (e) {
          console.error("Error stopping audio element:", e);
        }
      });
      
      // Find and remove any alert sound elements
      const alertSoundElements = document.querySelectorAll('#alert-sound-element, #primary-alert-sound');
      alertSoundElements.forEach(el => el.remove());
      
      console.log("All audio stopped successfully");
    } catch (e) {
      console.error("Error in forceStopAllAudio:", e);
    }
  };
  
  // Try an alternative method to play sound if the primary method fails
  const tryAlternativeAudioMethod = () => {
    // Don't try alternative method if user stopped sound
    if (userStoppedSound) {
      return;
    }
    
    try {
      // Create an audio element using DOM
      const altAudio = document.createElement('audio');
      altAudio.id = 'alert-sound-element';
      altAudio.src = `/alert-sound.mp3?v=${Date.now()}`;
      altAudio.volume = 1.0;
      altAudio.loop = true; // Also make this loop
      
      // Mute then unmute - workaround for some browsers
      altAudio.muted = true;
      setTimeout(() => { altAudio.muted = false; }, 10);
      
      // Add to body and play
      document.body.appendChild(altAudio);
      
      altAudio.addEventListener('canplaythrough', () => {
        // Check again if user stopped sound before playing
        if (userStoppedSound) {
          altAudio.remove();
          return;
        }
        
        const playPromise = altAudio.play();
        if (playPromise) {
          playPromise.catch(e => {
            console.error("Fallback audio also failed:", e);
            // Final alternative: play a system beep in browsers that support it
            if ('Notification' in window && Notification.permission === 'granted') {
              try {
                new Notification('Shoplifting Alert!');
              } catch (e) {
                console.error("Notification also failed:", e);
              }
            }
          });
        }
      });
      
      // Clean up after playing - this won't happen with loop until stopped manually
      activeAudio = altAudio;
      isSoundPlaying = true;
      
      altAudio.onended = () => {
        altAudio.remove();
        activeAudio = null;
        isSoundPlaying = false;
      };
    } catch (e2) {
      console.error("Fallback audio also failed:", e2);
    }
  };

  // Effect to handle Escape key press to dismiss the alert
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && isVisible) {
        dismissAlert();
      }
    };
    
    window.addEventListener('keydown', handleEscKey);
    return () => {
      window.removeEventListener('keydown', handleEscKey);
    };
  }, [isVisible]);

  // Component cleanup
  useEffect(() => {
    return () => {
      console.log("Component unmounting - stopping all audio");
      forceStopAllAudio();
      
      // Extra cleanup
      isSoundPlaying = false;
      activeAudio = null;
      
      // Find and remove all audio elements created by this component
      const alertSounds = document.querySelectorAll('#alert-sound-element, #primary-alert-sound');
      alertSounds.forEach(el => {
        try {
          el.pause();
          el.currentTime = 0;
          el.remove();
        } catch (e) {
          console.error("Error cleaning up audio:", e);
        }
      });
    };
  }, []);

  // Initialize polling
  useEffect(() => {
    setMounted(true);
    
    // Reset alert state on component first mount
    setIsVisible(false);
    setAlertData(null);
    setAlertQueue([]);
    userStoppedSound = false;
    isAppJustLoaded = true; // Set initial load flag
    
    // Clear any existing audio elements that might be left from previous sessions
    forceStopAllAudio();
    
    // Setup first check after interaction or after 5 seconds
    const initialCheck = () => {
      isAppJustLoaded = false; // User has interacted, no longer just loaded
      checkForAlerts();
      document.removeEventListener('click', initialCheck);
    };
    
    document.addEventListener('click', initialCheck);
    
    // Also reset the just loaded flag after 5 seconds even without interaction
    const resetLoadFlag = setTimeout(() => {
      isAppJustLoaded = false;
    }, 5000);
    
    return () => {
      document.removeEventListener('click', initialCheck);
      clearTimeout(resetLoadFlag);
    };
  }, []);
  
  // Setup regular polling for alerts
  useEffect(() => {
    if (!mounted) return;
    
    // Regular interval (5 seconds to check more frequently)
    const regularIntervalId = setInterval(() => {
      checkForAlerts();
    }, 5000);
    
    // Also run an immediate check
    checkForAlerts();
    
    // Cleanup on unmount
    return () => {
      clearInterval(regularIntervalId);
    };
  }, [mounted, isPollingPaused]);

  // Process the alert queue
  useEffect(() => {
    if (alertQueue.length > 0 && !isVisible && !isDismissing) {
      // Show the next alert in the queue
      const nextAlert = alertQueue[0];
      setAlertData(nextAlert);
      setIsVisible(true);
      setAlertQueue(prevQueue => prevQueue.slice(1));
      // Reset userStoppedSound flag for new alerts from queue
      userStoppedSound = false;
      playAlertSound();
    }
  }, [alertQueue, isVisible, isDismissing]);

  // Keep sound playing if alert is visible
  useEffect(() => {
    // If alert is visible but no sound is playing, restart it
    let soundCheckInterval;
    
    if (isVisible && alertData) {
      soundCheckInterval = setInterval(() => {
        // Only restart if not deliberately stopped by user
        if (!isSoundPlaying && activeAudio === null && !userStoppedSound) {
          console.log("Sound stopped but alert still visible - restarting sound");
          playAlertSound();
        }
      }, 2000); // Check every 2 seconds
    }
    
    return () => {
      if (soundCheckInterval) {
        clearInterval(soundCheckInterval);
      }
    };
  }, [isVisible, alertData]);

  // Clear older processed alerts to prevent memory leaks
  useEffect(() => {
    // Every minute, clean up processed alerts older than 2 hours
    const cleanupInterval = setInterval(() => {
      // In a real implementation, we could track timestamps with IDs
      // For now, just limit the size of the Set
      if (processedAlerts.current.size > 100) {
        processedAlerts.current = new Set(
          Array.from(processedAlerts.current).slice(-50)
        );
      }
    }, 60000);
    
    return () => clearInterval(cleanupInterval);
  }, []);

  // Clear state on navigation
  useEffect(() => {
    // Listen for route changes (this will differ based on your routing implementation)
    const handleRouteChange = () => {
      // Reset alert-related state when route changes
      if (isVisible) {
        console.log("Route changed while alert was visible - dismissing alert");
        forceStopAllAudio();
        setIsVisible(false);
        setAlertData(null);
        userStoppedSound = true; // Prevent auto-restart
      }
    };

    // Add listener for location/history changes
    window.addEventListener('popstate', handleRouteChange);
    
    // Clean up listener
    return () => {
      window.removeEventListener('popstate', handleRouteChange);
    };
  }, [isVisible]);
  
  // Use localStorage to prevent alerts on page reload
  useEffect(() => {
    // Check if we're in a page reload scenario
    const lastSessionTime = localStorage.getItem('lastAlertSessionTime');
    const currentTime = Date.now();
    
    if (lastSessionTime) {
      const timeSinceLastSession = currentTime - parseInt(lastSessionTime, 10);
      // If less than 3 seconds since last session, likely a reload
      if (timeSinceLastSession < 3000) {
        isAppJustLoaded = true;
        console.log("Page reload detected - will suppress initial alerts");
        // Extend the suppression period a bit longer for reloads
        setTimeout(() => {
          isAppJustLoaded = false;
          console.log("Alert suppression period ended after reload");
        }, 10000); // 10 seconds for reload vs 5 for normal load
      }
    }
    
    // Update last session time regularly
    const updateSessionInterval = setInterval(() => {
      localStorage.setItem('lastAlertSessionTime', Date.now().toString());
    }, 1000);
    
    // Initial setting
    localStorage.setItem('lastAlertSessionTime', currentTime.toString());
    
    return () => {
      clearInterval(updateSessionInterval);
    };
  }, []);

  const handleViewCamera = () => {
    console.log("View Camera button clicked - stopping audio");
    userStoppedSound = true; // Set flag to prevent auto-restart
    forceStopAllAudio(); // Ensure audio stops
    
    // Additional cleanup
    isSoundPlaying = false;
    activeAudio = null;
    
    dismissAlert();
    
    // Pause polling while navigating
    setIsPollingPaused(true);
    setTimeout(() => setIsPollingPaused(false), 5000);
    
    navigate('/shoplifting-detection');
  };

  const handleViewEvidence = () => {
    console.log("View Evidence button clicked - stopping audio");
    userStoppedSound = true; // Set flag to prevent auto-restart
    forceStopAllAudio(); // Ensure audio stops
    
    // Additional cleanup
    isSoundPlaying = false;
    activeAudio = null;
    
    dismissAlert();
    
    // Pause polling while navigating
    setIsPollingPaused(true);
    setTimeout(() => setIsPollingPaused(false), 5000);
    
    navigate('/recent-activity');
  };

  const dismissAlert = () => {
    console.log("Dismiss button clicked - stopping audio");
    userStoppedSound = true;
    forceStopAllAudio();
    
    // Additional cleanup 
    isSoundPlaying = false;
    activeAudio = null;
    
    // Clear any pending sound timeout
    if (soundTimeout) {
      clearTimeout(soundTimeout);
      soundTimeout = null;
    }
    
    setIsDismissing(true);
    setTimeout(() => {
      setIsVisible(false);
      setIsDismissing(false);
      
      // Reset the userStoppedSound flag after a delay
      setTimeout(() => {
        userStoppedSound = false;
      }, 1000);
    }, 300);
  };

  // Always render the container even if no visible alert
  if (!isVisible || !alertData) {
    return <div className="shoplifting-alert-container" style={{display: 'none'}} />;
  }

  const animationClass = isDismissing 
    ? 'animate-slide-out-right' 
    : 'animate-slide-in-right';

  return (
    <div className={`fixed top-20 right-4 w-96 z-50 ${animationClass}`}>
      <div className="bg-zinc-900 border border-red-600 rounded-lg shadow-lg overflow-hidden">
        <div className="bg-red-600 p-2 flex items-center justify-between">
          <div className="flex items-center">
            <svg className="w-5 h-5 text-white mr-2 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-white font-bold">SHOPLIFTING ALERT!!</span>
          </div>
          <button 
            onClick={dismissAlert}
            className="text-white hover:text-gray-200"
            aria-label="Close alert"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div className="p-4">
          <p className="text-white text-center font-medium mb-3">
            Shoplifting Detected At<br />
            {alertData.camera_name}
          </p>
          
          {alertData.thumbnail && (
            <div className="aspect-video bg-black rounded mb-3 overflow-hidden">
              <img 
                src={alertData.thumbnail} 
                alt="Alert thumbnail" 
                className="w-full h-full object-cover"
              />
            </div>
          )}
          
          <div className="flex justify-between space-x-2">
            <button
              onClick={handleViewCamera}
              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white py-2 px-3 rounded text-sm font-medium transition-colors"
            >
              View Camera
            </button>
          </div>
          
          
          
        </div>
      </div>
    </div>
  );
}

export default ShopliftingAlert; 