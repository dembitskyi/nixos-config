{
  lib,
  config,
  ...
}:
{
  config = lib.mkIf config.mine.hyprland.enable {
    home-manager.users.${config.variables.username} = {
      systemd.user.services.noctalia-shell.Service.Environment = [
        "QT_QPA_PLATFORM=wayland"
      ];

      home.file.".cache/noctalia/wallpapers.json" = {
        text = builtins.toJSON {
          defaultWallpaper = ../../wallpapers/wallhaven_433729.jpg;
        };
      };
      imports = [
        ./plugins.nix
      ];

      programs.noctalia-shell = {
        enable = true;
        systemd.enable = true;
        settings = {
          appLauncher = {
            customLaunchPrefix = "";
            customLaunchPrefixEnabled = false;
            enableClipPreview = true;
            enableClipboardHistory = false;
            iconMode = "tabler";
            pinnedExecs = [ ];
            position = "center";
            showCategories = true;
            sortByMostUsed = true;
            terminalCommand = "xterm -e";
            useApp2Unit = false;
            viewMode = "list";
          };

          audio = {
            cavaFrameRate = 30;
            externalMixer = "pwvucontrol || pavucontrol";
            mprisBlacklist = [ ];
            preferredPlayer = "";
            visualizerType = "linear";
            volumeOverdrive = false;
            volumeStep = 5;
          };

          bar = {
            backgroundOpacity = 0.93;
            capsuleOpacity = 1;
            density = "comfortable";
            exclusive = true;
            floating = false;
            marginHorizontal = 0.25;
            marginVertical = 0.25;
            monitors = [ ];
            outerCorners = true;
            position = "top";
            showCapsule = false;
            showOutline = false;
            useSeparateOpacity = false;
            widgets = {
              center = [
                {
                  customFont = "Hack Nerd Font Mono";
                  formatHorizontal = "ddd, MMM d | HH:mm:ss";
                  formatVertical = "HH mm";
                  id = "Clock";
                  tooltipFormat = "HH:mm ddd, MMM dd";
                  useCustomFont = true;
                  usePrimaryColor = true;
                }
                #{
                #  id = "plugin:world-clock";
                #}
                {
                  hideWhenZero = false;
                  id = "NotificationHistory";
                  showUnreadBadge = true;
                }
              ];
              left = [ ];
              right = [
                {
                  blacklist = [ ];
                  colorizeIcons = false;
                  drawerEnabled = true;
                  hidePassive = false;
                  id = "Tray";
                  pinned = config.variables.pinnedTrayApps;
                }
                {
                  displayMode = "forceOpen";
                  id = "KeyboardLayout";
                }
                {
                  displayMode = "onhover";
                  id = "Volume";
                }
                {
                  deviceNativePath = "";
                  displayMode = "onhover";
                  hideIfNotDetected = true;
                  id = "Battery";
                  showNoctaliaPerformance = false;
                  showPowerProfiles = false;
                  warningThreshold = 30;
                }
                {
                  compactMode = true;
                  diskPath = "/";
                  id = "SystemMonitor";
                  showCpuTemp = true;
                  showCpuUsage = true;
                  showDiskUsage = false;
                  showGpuTemp = false;
                  showMemoryAsPercent = false;
                  showMemoryUsage = true;
                  showNetworkStats = false;
                  useMonospaceFont = true;
                  usePrimaryColor = false;
                }
                {
                  colorizeDistroLogo = false;
                  colorizeSystemIcon = "none";
                  customIconPath = "";
                  enableColorization = false;
                  icon = "noctalia";
                  id = "ControlCenter";
                  useDistroLogo = true;
                }
              ];
            };
          };

          brightness = {
            brightnessStep = 5;
            enableDdcSupport = false;
            enforceMinimum = true;
          };

          calendar = {
            cards = [
              {
                enabled = true;
                id = "calendar-header-card";
              }
              {
                enabled = true;
                id = "calendar-month-card";
              }
              {
                enabled = false;
                id = "timer-card";
              }
              {
                enabled = true;
                id = "weather-card";
              }
            ];
          };

          colorSchemes = {
            darkMode = true;
            generateTemplatesForPredefined = true;
            manualSunrise = "06:30";
            manualSunset = "18:30";
            matugenSchemeType = "scheme-fruit-salad";
            predefinedScheme = "Ayu";
            schedulingMode = "off";
            useWallpaperColors = false;
          };

          controlCenter = {
            cards = [
              {
                enabled = true;
                id = "profile-card";
              }
              {
                enabled = true;
                id = "shortcuts-card";
              }
              {
                enabled = true;
                id = "audio-card";
              }
              {
                enabled = false;
                id = "brightness-card";
              }
              {
                enabled = true;
                id = "weather-card";
              }
              {
                enabled = true;
                id = "media-sysmon-card";
              }
            ];
            position = "close_to_bar_button";
            shortcuts = {
              left = [
                { id = "WiFi"; }
                { id = "Bluetooth"; }
                { id = "ScreenRecorder"; }
                { id = "WallpaperSelector"; }
              ];
              right = [
                { id = "Notifications"; }
                { id = "PowerProfile"; }
                { id = "KeepAwake"; }
                { id = "NightLight"; }
              ];
            };
          };

          desktopWidgets = {
            enabled = false;
            gridSnap = false;
            monitorWidgets = [ ];
          };

          dock = {
            animationSpeed = 1;
            backgroundOpacity = 1;
            colorizeIcons = false;
            deadOpacity = 0.6;
            displayMode = "auto_hide";
            enabled = false;
            floatingRatio = 1;
            inactiveIndicators = false;
            monitors = [ ];
            onlySameOutput = true;
            pinnedApps = [ ];
            pinnedStatic = false;
            size = 1;
          };

          general = {
            allowPanelsOnScreenWithoutBar = true;
            animationDisabled = false;
            animationSpeed = 1;
            avatarImage = ../../icons/avatars/profile.png;
            boxRadiusRatio = 1;
            compactLockScreen = false;
            dimmerOpacity = 0.2;
            enableShadows = true;
            forceBlackScreenCorners = false;
            iRadiusRatio = 1;
            language = "";
            lockOnSuspend = true;
            radiusRatio = 0.2;
            scaleRatio = 1;
            screenRadiusRatio = 1;
            shadowDirection = "bottom_right";
            shadowOffsetX = 2;
            shadowOffsetY = 3;
            showHibernateOnLockScreen = false;
            showScreenCorners = false;
            showChangelogOnStartup = false;
            showSessionButtonsOnLockScreen = false;
          };

          hooks = {
            darkModeChange = "";
            enabled = false;
            performanceModeDisabled = "";
            performanceModeEnabled = "";
            screenLock = "";
            screenUnlock = "";
            wallpaperChange = "";
          };

          location = {
            analogClockInCalendar = false;
            firstDayOfWeek = -1;
            name = "Dallas, USA";
            showCalendarEvents = true;
            showCalendarWeather = true;
            showWeekNumberInCalendar = false;
            use12hourFormat = false;
            useFahrenheit = false;
            weatherEnabled = true;
            weatherShowEffects = true;
          };

          network = {
            wifiEnabled = false;
          };

          nightLight = {
            autoSchedule = true;
            dayTemp = "6500";
            enabled = false;
            forced = false;
            manualSunrise = "06:30";
            manualSunset = "18:30";
            nightTemp = "4000";
          };

          notifications = {
            backgroundOpacity = 1;
            criticalUrgencyDuration = 15;
            enableKeyboardLayoutToast = true;
            enabled = true;
            location = "top_right";
            lowUrgencyDuration = 3;
            monitors = [ ];
            normalUrgencyDuration = 8;
            overlayLayer = true;
            respectExpireTimeout = false;
            saveToHistory = {
              critical = true;
              low = true;
              normal = true;
            };
            sounds = {
              criticalSoundFile = "";
              enabled = false;
              excludedApps = "discord,firefox,chrome,chromium,edge";
              lowSoundFile = "";
              normalSoundFile = "";
              separateSounds = false;
              volume = 0.5;
            };
          };

          osd = {
            autoHideMs = 2000;
            backgroundOpacity = 1;
            enabled = true;
            enabledTypes = [
              0
              1
              2
              4
            ];
            location = "top_right";
            monitors = [ ];
            overlayLayer = true;
          };

          plugins = {
            autoUpdate = false;
            notifyUpdates = false;
          };

          screenRecorder = {
            audioCodec = "opus";
            audioSource = "default_output";
            colorRange = "limited";
            copyToClipboard = false;
            directory = "/home/${config.variables.username}/Videos";
            frameRate = 60;
            quality = "very_high";
            showCursor = true;
            videoCodec = "h264";
            videoSource = "portal";
          };

          sessionMenu = {
            countdownDuration = 10000;
            enableCountdown = false;
            largeButtonsStyle = false;
            position = "center";
            powerOptions = [
              {
                action = "lock";
                enabled = true;
              }
              {
                action = "suspend";
                enabled = true;
              }
              {
                action = "hibernate";
                enabled = true;
              }
              {
                action = "reboot";
                enabled = true;
              }
              {
                action = "logout";
                enabled = true;
              }
              {
                action = "shutdown";
                enabled = true;
              }
            ];
            showHeader = true;
            showNumberLabels = true;
          };

          settingsVersion = 35;

          systemMonitor = {
            cpuCriticalThreshold = 90;
            cpuPollingInterval = 3000;
            cpuWarningThreshold = 80;
            criticalColor = "";
            diskCriticalThreshold = 90;
            diskPath = "/";
            diskPollingInterval = 3000;
            diskWarningThreshold = 80;
            enableDgpuMonitoring = false;
            gpuCriticalThreshold = 90;
            gpuPollingInterval = 3000;
            gpuWarningThreshold = 80;
            memCriticalThreshold = 90;
            memPollingInterval = 3000;
            memWarningThreshold = 80;
            networkPollingInterval = 3000;
            tempCriticalThreshold = 90;
            tempPollingInterval = 3000;
            tempWarningThreshold = 80;
            useCustomColors = false;
            warningColor = "";
          };

          templates = {
            alacritty = false;
            cava = false;
            code = false;
            discord = false;
            emacs = false;
            enableUserTemplates = false;
            foot = false;
            fuzzel = false;
            ghostty = false;
            gtk = false;
            helix = false;
            hyprland = false;
            kcolorscheme = false;
            kitty = false;
            mango = false;
            niri = false;
            pywalfox = false;
            qt = false;
            spicetify = false;
            telegram = false;
            vicinae = false;
            walker = false;
            wezterm = false;
            yazi = false;
            zed = false;
          };

          ui = {
            bluetoothDetailsViewMode = "grid";
            bluetoothHideUnnamedDevices = false;
            fontDefault = "Sans Serif";
            fontDefaultScale = 1;
            fontFixed = "monospace";
            fontFixedScale = 1;
            panelBackgroundOpacity = 0.93;
            panelsAttachedToBar = true;
            settingsPanelMode = "attached";
            tooltipsEnabled = true;
            wifiDetailsViewMode = "grid";
          };

          wallpaper = {
            directory = "/home/${config.variables.username}/Pictures/Wallpapers";
            enableMultiMonitorDirectories = false;
            enabled = true;
            fillColor = "#000000";
            fillMode = "crop";
            hideWallpaperFilenames = false;
            monitorDirectories = [ ];
            overviewEnabled = false;
            panelPosition = "follow_bar";
            randomEnabled = false;
            randomIntervalSec = 300;
            recursiveSearch = false;
            setWallpaperOnAllMonitors = true;
            transitionDuration = 1500;
            transitionEdgeSmoothness = 0.05;
            transitionType = "random";
            useWallhaven = false;
          };
        };
        # this may also be a string or a path to a JSON file,
        # but in this case must include *all* settings.
      };
    };
  };
}
