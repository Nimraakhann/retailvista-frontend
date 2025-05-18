import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

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
  const navigate = useNavigate();

  // Move refs inside the component
  const audioRef = useRef(null);
  const soundTimeoutRef = useRef(null);
  const isSoundPlayingRef = useRef(false);
  const userStoppedSoundRef = useRef(false);
  const isAppJustLoadedRef = useRef(true);

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
        if (isAppJustLoadedRef.current) {
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
    
    // Check localStorage for shown alerts (not just reviewed)
    try {
      const shownAlerts = JSON.parse(localStorage.getItem('shownAlerts') || '[]');
      if (shownAlerts.includes(alert.id)) {
        // Add to our in-memory set to avoid future checks
        processedAlerts.current.add(alert.id);
        return false;
      }
    } catch (e) {
      console.error("Error checking shown alerts in localStorage:", e);
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
    if (isAppJustLoadedRef.current) {
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
        userStoppedSoundRef.current = false;
        playAlertSound();

        // Mark this alert as shown in localStorage
        try {
          const shownAlerts = JSON.parse(localStorage.getItem('shownAlerts') || '[]');
          if (!shownAlerts.includes(newAlert.id)) {
            shownAlerts.push(newAlert.id);
            localStorage.setItem('shownAlerts', JSON.stringify(shownAlerts));
          }
        } catch (e) {
          console.error("Error saving shown alert to localStorage:", e);
        }
      } else {
        // Otherwise add it to the queue
        setAlertQueue(prevQueue => [...prevQueue, newAlert]);
      }
    }
  };

  // Play the alert sound - completely new implementation
  const playAlertSound = () => {
    // Don't play if user stopped sound or app just loaded
    if (userStoppedSoundRef.current || isAppJustLoadedRef.current) {
      return;
    }

    // Clear any existing timeout
    if (soundTimeoutRef.current) {
      clearTimeout(soundTimeoutRef.current);
      soundTimeoutRef.current = null;
    }

    // Create audio element if it doesn't exist
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.loop = true;
      audioRef.current.id = 'primary-alert-sound';
      
      // Add error handler
      audioRef.current.onerror = (e) => {
        console.error("Audio error:", e);
        isSoundPlayingRef.current = false;
        // Don't retry if user stopped sound
        if (!userStoppedSoundRef.current) {
          // Wait a bit before retrying
          setTimeout(() => {
            if (!userStoppedSoundRef.current) {
              playAlertSound();
            }
          }, 1000);
        }
      };
    }

    // Only play if not already playing
    if (!isSoundPlayingRef.current) {
      try {
        // Add cache buster to prevent caching issues
        audioRef.current.src = `/alert-sound.mp3?v=${Date.now()}`;
        
        // Try to play
        const playPromise = audioRef.current.play();
        
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              console.log("Alert sound playing");
              isSoundPlayingRef.current = true;
              
              // Set timeout to stop sound after 30 seconds
              soundTimeoutRef.current = setTimeout(() => {
                if (isSoundPlayingRef.current && !userStoppedSoundRef.current) {
                  stopAlertSound();
                }
              }, 30000);
            })
            .catch((error) => {
              console.error("Error playing sound:", error);
              isSoundPlayingRef.current = false;
            });
        }
      } catch (error) {
        console.error("Error in playAlertSound:", error);
        isSoundPlayingRef.current = false;
      }
    }
  };
  
  // Completely stop all audio to ensure nothing keeps playing
  const forceStopAllAudio = () => {
    stopAlertSound();
    userStoppedSoundRef.current = true;
    
    // Reset userStoppedSound after 1 second
    setTimeout(() => {
      userStoppedSoundRef.current = false;
    }, 1000);
  };
  
  // Try an alternative method to play sound if the primary method fails
  const tryAlternativeAudioMethod = () => {
    // Don't try alternative method if user stopped sound
    if (userStoppedSoundRef.current) {
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
        if (userStoppedSoundRef.current) {
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
      audioRef.current = altAudio;
      isSoundPlayingRef.current = true;
      
      altAudio.onended = () => {
        altAudio.remove();
        audioRef.current = null;
        isSoundPlayingRef.current = false;
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
      isSoundPlayingRef.current = false;
      audioRef.current = null;
      
      // Find and remove all audio elements created by this component
      const alertSounds = document.querySelectorAll('#alert-sound-element, #primary-alert-sound');
      alertSounds.forEach(el => el.remove());
    };
  }, []);

  // Initialize polling
  useEffect(() => {
    setMounted(true);
    
    // Reset alert state on component first mount
    setIsVisible(false);
    setAlertData(null);
    setAlertQueue([]);
    userStoppedSoundRef.current = false;
    isAppJustLoadedRef.current = true; // Set initial load flag
    
    // Clear any existing audio elements that might be left from previous sessions
    forceStopAllAudio();
    
    // Setup first check after interaction or after 5 seconds
    const initialCheck = () => {
      isAppJustLoadedRef.current = false; // User has interacted, no longer just loaded
      checkForAlerts();
      document.removeEventListener('click', initialCheck);
    };
    
    document.addEventListener('click', initialCheck);
    
    // Also reset the just loaded flag after 5 seconds even without interaction
    const resetLoadFlag = setTimeout(() => {
      isAppJustLoadedRef.current = false;
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
      userStoppedSoundRef.current = false;
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
        if (!isSoundPlayingRef.current && audioRef.current === null && !userStoppedSoundRef.current) {
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
        userStoppedSoundRef.current = true; // Prevent auto-restart
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
        isAppJustLoadedRef.current = true;
        console.log("Page reload detected - will suppress initial alerts");
        // Extend the suppression period a bit longer for reloads
        setTimeout(() => {
          isAppJustLoadedRef.current = false;
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
    userStoppedSoundRef.current = true; // Set flag to prevent auto-restart
    forceStopAllAudio(); // Ensure audio stops
    
    // Additional cleanup
    isSoundPlayingRef.current = false;
    audioRef.current = null;
    
    dismissAlert();
    
    // Pause polling while navigating
    setIsPollingPaused(true);
    setTimeout(() => setIsPollingPaused(false), 5000);
    
    navigate('/shoplifting-detection');
  };

  const handleViewEvidence = () => {
    console.log("View Evidence button clicked - stopping audio");
    userStoppedSoundRef.current = true; // Set flag to prevent auto-restart
    forceStopAllAudio(); // Ensure audio stops
    
    // Additional cleanup
    isSoundPlayingRef.current = false;
    audioRef.current = null;
    
    dismissAlert();
    
    // Pause polling while navigating
    setIsPollingPaused(true);
    setTimeout(() => setIsPollingPaused(false), 5000);
    
    navigate('/recent-activity');
  };

  const dismissAlert = () => {
    console.log("Dismiss button clicked - stopping audio");
    forceStopAllAudio();
    
    setIsDismissing(true);
    setTimeout(() => {
      setIsVisible(false);
      setIsDismissing(false);
    }, 300);
  };

  // Add new stopAlertSound function:
  const stopAlertSound = () => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        isSoundPlayingRef.current = false;
      } catch (error) {
        console.error("Error stopping sound:", error);
      }
    }
    
    if (soundTimeoutRef.current) {
      clearTimeout(soundTimeoutRef.current);
      soundTimeoutRef.current = null;
    }
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