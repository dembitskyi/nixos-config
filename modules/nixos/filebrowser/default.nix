{
  lib,
  config,
  pkgs,
  ...
}:
{
  options = {
    mine.filebrowser.enable = lib.mkEnableOption "enable filebrowser";
  };

  config = lib.mkIf config.mine.filebrowser.enable {
    services.nginx = {
      enable = true;
      virtualHosts."drive.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:${toString config.variables.filebrowser-port}";
          proxyWebsockets = true;
        };
      };
    };

    sops.secrets = {
      filebrowser-admin-password = {
        owner = "filebrowser";
      };
      filebrowser-getdata-password = {
        owner = "filebrowser";
      };
    };

    # Create dedicated filebrowser user and group
    users.users.filebrowser = {
      isSystemUser = true;
      group = "filebrowser";
      extraGroups = [ "users" ]; # Add to 'users' group for CIFS mount access
      home = "/var/lib/filebrowser";
      createHome = true;
      # Let NixOS auto-assign UID (currently 999 on misc)
    };
    users.groups.filebrowser = {
      # Let NixOS auto-assign GID (currently 982 on misc)
    };

    # Filebrowser systemd service
    systemd.services.filebrowser = {
      description = "Filebrowser Web File Manager";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network.target"
        "filebrowser-config.service"
        "filebrowser-ensure-getdata.service"
      ];
      requires = [ "filebrowser-config.service" ];

      serviceConfig = {
        Type = "exec";
        User = "filebrowser";
        Group = "filebrowser";
        WorkingDirectory = "/var/lib/filebrowser";
        ExecStart = "${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db";
        Restart = "always";
        RestartSec = "10";

        # Security hardening
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [
          "/var/lib/filebrowser"
          "/srv/filebrowser"
        ];
      };
    };

    # Create configuration file
    systemd.services.filebrowser-config = {
      description = "Generate Filebrowser configuration";
      wantedBy = [ "multi-user.target" ];
      before = [ "filebrowser.service" ];

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "filebrowser";
        Group = "filebrowser";
        # Fix ownership before running as filebrowser user (+ prefix = run as root)
        ExecStartPre = "+${pkgs.bash}/bin/bash -c '${pkgs.coreutils}/bin/chown -R filebrowser:filebrowser /var/lib/filebrowser'";
      };

      script = ''
        # Ensure directories exist
        mkdir -p /var/lib/filebrowser
        mkdir -p /srv/filebrowser
        mkdir -p /var/lib/filebrowser/getdata-home
        mkdir -p /var/lib/filebrowser/getdata-home/videos

        # Remove old flat symlinks (from previous config)
        rm -f /var/lib/filebrowser/getdata-home/documentaries
        rm -f /var/lib/filebrowser/getdata-home/it
        rm -f /var/lib/filebrowser/getdata-home/movies
        rm -f /var/lib/filebrowser/getdata-home/music-videos
        rm -f /var/lib/filebrowser/getdata-home/scenery
        rm -f /var/lib/filebrowser/getdata-home/tv
        rm -f /var/lib/filebrowser/getdata-home/workout

        # Create symlinks for getdata user's scoped access (preserving directory structure)
        # Videos subdirectories
        ln -sf /srv/filebrowser/videos/documentaries /var/lib/filebrowser/getdata-home/videos/documentaries 2>/dev/null || true
        ln -sf /srv/filebrowser/videos/it /var/lib/filebrowser/getdata-home/videos/it 2>/dev/null || true
        ln -sf /srv/filebrowser/videos/movies /var/lib/filebrowser/getdata-home/videos/movies 2>/dev/null || true
        ln -sf /srv/filebrowser/videos/music /var/lib/filebrowser/getdata-home/videos/music 2>/dev/null || true
        ln -sf /srv/filebrowser/videos/scenery /var/lib/filebrowser/getdata-home/videos/scenery 2>/dev/null || true
        ln -sf /srv/filebrowser/videos/tv /var/lib/filebrowser/getdata-home/videos/tv 2>/dev/null || true
        ln -sf /srv/filebrowser/videos/workout /var/lib/filebrowser/getdata-home/videos/workout 2>/dev/null || true
        # Top-level directories
        ln -sf /srv/filebrowser/games /var/lib/filebrowser/getdata-home/games 2>/dev/null || true
        ln -sf /srv/filebrowser/music /var/lib/filebrowser/getdata-home/music 2>/dev/null || true
        ln -sf /srv/filebrowser/software /var/lib/filebrowser/getdata-home/software 2>/dev/null || true
        ln -sf /srv/filebrowser/vst /var/lib/filebrowser/getdata-home/vst 2>/dev/null || true

        # Create configuration file
        if [ ! -f /var/lib/filebrowser/config.json ] ; then
          cp ${./config.json} /var/lib/filebrowser/config.json
        fi
        # Initialize database and create users if they don't exist
        if [ ! -f /var/lib/filebrowser/database.db ]; then
          # Initialize filebrowser database
          ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db config import /var/lib/filebrowser/config.json

          # Create admin user with password from secret
          # Workaround: filebrowser CLI tries to mkdir scope dir, use "." then update
          ADMIN_PASSWORD=$(cat ${config.sops.secrets.filebrowser-admin-password.path})
          ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users add admin "$ADMIN_PASSWORD" \
            --scope "." \
            --perm.admin
          # Update admin scope to /srv/filebrowser mount point
          ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users update admin \
            --scope "/srv/filebrowser"

          # Create getdata read-only user with scoped access
          # Workaround: filebrowser CLI tries to create scope dir, so temporarily rename it
          GETDATA_PASSWORD=$(cat ${config.sops.secrets.filebrowser-getdata-password.path})
          mv /var/lib/filebrowser/getdata-home /var/lib/filebrowser/getdata-home.tmp
          ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users add getdata "$GETDATA_PASSWORD" \
            --scope "/var/lib/filebrowser/getdata-home" \
            --perm.admin=false \
            --perm.execute=false \
            --perm.create=false \
            --perm.rename=false \
            --perm.modify=false \
            --perm.delete=false \
            --perm.share=false \
            --perm.download=true
          # Remove empty dir created by filebrowser and restore symlinks
          rm -rf /var/lib/filebrowser/getdata-home
          mv /var/lib/filebrowser/getdata-home.tmp /var/lib/filebrowser/getdata-home
        fi

        # Set proper permissions
        chown -R filebrowser:filebrowser /var/lib/filebrowser
      '';
    };

    # Create filebrowser data directory
    systemd.tmpfiles.rules = [
      "d /var/lib/filebrowser 0755 filebrowser filebrowser - -"
      "d /var/lib/filebrowser/getdata-home 0755 filebrowser filebrowser - -"
      "d /var/lib/filebrowser/getdata-home/videos 0755 filebrowser filebrowser - -"
    ];

    # One-time service to ensure getdata user exists (for existing databases)
    systemd.services.filebrowser-ensure-getdata = {
      description = "Ensure Filebrowser getdata user exists";
      wantedBy = [ "multi-user.target" ];
      after = [
        "filebrowser-config.service"
        "systemd-tmpfiles-setup.service"
      ];
      requires = [ "filebrowser-config.service" ]; # Must run after config service creates symlinks
      before = [ "filebrowser.service" ];
      conflicts = [ "filebrowser.service" ]; # Stop filebrowser while we modify database
      upholds = [ "filebrowser.service" ]; # Ensure filebrowser starts after this service completes

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "filebrowser";
        Group = "filebrowser";
        # No protection to allow directory manipulation
        ProtectSystem = "false";
        ProtectHome = "false";
      };

      script = ''
        # Update admin user scope to /srv/filebrowser (in case it was created with old root)
        echo "Updating admin user scope to /srv/filebrowser..."
        ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users update admin \
          --scope "/srv/filebrowser" 2>/dev/null || true

        # Check if getdata user already exists in database
        if ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users ls 2>/dev/null | grep -q "^2.*getdata"; then
          echo "getdata user already exists, updating password lock..."
          ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users update getdata \
            --lockPassword 2>/dev/null || true
          echo "getdata user updated successfully"
          exit 0
        fi

        echo "Creating getdata user..."

        # Workaround: filebrowser CLI has issues with existing directories for scope
        # Solution: Create user with temporary scope, then update to final scope
        GETDATA_PASSWORD=$(cat ${config.sops.secrets.filebrowser-getdata-password.path})

        # Create user with default scope first
        ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users add getdata "$GETDATA_PASSWORD" \
          --scope "." \
          --perm.admin=false \
          --perm.execute=false \
          --perm.create=false \
          --perm.rename=false \
          --perm.modify=false \
          --perm.delete=false \
          --perm.share=false \
          --perm.download=true \
          --lockPassword

        # Update user to use the symlink directory as scope
        echo "Updating scope to /var/lib/filebrowser/getdata-home..."
        ${pkgs.filebrowser}/bin/filebrowser -d /var/lib/filebrowser/database.db users update getdata \
          --scope "/var/lib/filebrowser/getdata-home" \
          --lockPassword

        echo "getdata user created successfully"
      '';
    };
  };
}
