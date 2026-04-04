# Mobius4 Prerequisites Installation Guide

This guide covers installing all prerequisites for Mobius4 on each supported OS.

| Software | Required version | Windows | macOS | Linux |
| :--- | :---: | :---: | :---: | :---: |
| Node.js | v22 | Official installer | Official installer | NodeSource |
| PostgreSQL | v17 | EDB installer | Homebrew | PGDG apt repo |
| PostGIS | 3.x | StackBuilder | Homebrew | PGDG apt repo |
| Mosquitto | 2.x | Official installer | Homebrew | apt |

---

## Windows

### Node.js v22

Download and run the official Node.js 22 Windows installer from:
https://nodejs.org/en/download/

Select **LTS** and choose the Windows Installer (`.msi`) for x64. The installer adds `node` and `npm` to `PATH` automatically.

Verify:
```cmd
node --version
npm --version
```

**Managing multiple Node.js versions** — If you need to switch between Node.js versions across different projects, use [nvm-windows](https://github.com/coreybutler/nvm-windows) instead:
1. Uninstall any existing Node.js installation first to avoid conflicts.
2. Download `nvm-setup.exe` from the releases page and run the installer.
3. Open a new Administrator terminal (required for the first `nvm use` call, which creates a symlink in `Program Files`):
```cmd
nvm install 22
nvm use 22
```

---

### PostgreSQL v17

Use the **EDB interactive installer** — the official PostgreSQL project distribution for Windows.

1. Download the PostgreSQL 17 Windows installer from:
   https://www.enterprisedb.com/downloads/postgres-postgresql-downloads
   (select version 17.x, Windows x86-64)
2. Run the `.exe` as Administrator. The wizard installs the PostgreSQL server, pgAdmin 4, StackBuilder, and command-line tools.
3. During setup, set a superuser (`postgres`) password and note the port (default: `5432`).
4. The `postgresql-x64-17` service is registered and starts automatically.

Verify:
```cmd
psql -U postgres -c "SELECT version();"
```

---

### PostGIS

Use **StackBuilder**, which is installed alongside PostgreSQL.

1. Launch **Stack Builder** from: Start Menu > PostgreSQL 17 > Application Stack Builder
2. Select your PostgreSQL 17 installation from the dropdown.
3. Expand **Spatial Extensions** and check **PostGIS 3.x Bundle for PostgreSQL 17**.
4. Click Next and follow the installer wizard.

After installation, enable PostGIS in your database:
```sql
CREATE EXTENSION postgis;
```

---

### Mosquitto

1. Download the installer from:
   https://mosquitto.org/download/
   (select `mosquitto-2.x.x-install-windows-x64.exe`)
2. Run the installer. During component selection, check **Service** and **Visual Studio Runtime**.

**Required configuration** — Mosquitto v2+ rejects all connections without explicit configuration. Edit:
```
C:\Program Files\mosquitto\mosquitto.conf
```
Add the following lines:
```
listener 1883 0.0.0.0
allow_anonymous true
```

Restart the service (run as Administrator):
```cmd
sc stop mosquitto
sc start mosquitto
```

Verify (open two separate terminals):
```cmd
mosquitto_sub -h localhost -t "test"
mosquitto_pub -h localhost -t "test" -m "hello"
```

---

## macOS

### Node.js v22

Download and run the official Node.js 22 macOS installer from:
https://nodejs.org/en/download/

Select **LTS** and choose the macOS Installer (`.pkg`). The installer adds `node` and `npm` to `PATH` automatically.

Verify:
```bash
node --version
npm --version
```

**Managing multiple Node.js versions** — If you need to switch between Node.js versions across different projects, use [nvm](https://github.com/nvm-sh/nvm) instead:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
source ~/.zshrc
nvm install 22
nvm use 22
nvm alias default 22
```

---

### PostgreSQL v17

```bash
brew install postgresql@17
```

**PATH setup** — Homebrew installs this as a keg-only formula and does not add it to `PATH` automatically.

Apple Silicon (M1/M2/M3):
```bash
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Intel Mac:
```bash
echo 'export PATH="/usr/local/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Start the service (auto-starts on login):
```bash
brew services start postgresql@17
```

Verify:
```bash
psql postgres -c "SELECT version();"
```

---

### PostGIS

```bash
brew install postgis
```

Enable PostGIS in your database:
```sql
CREATE EXTENSION postgis;
```

Verify:
```sql
SELECT PostGIS_Version();
```

---

### Mosquitto

```bash
brew install mosquitto
brew services start mosquitto
```

**Required configuration** — Mosquitto v2+ rejects all connections without explicit configuration. Edit the config file:

- Apple Silicon: `/opt/homebrew/etc/mosquitto/mosquitto.conf`
- Intel Mac: `/usr/local/etc/mosquitto/mosquitto.conf`

Add the following lines:
```
listener 1883 0.0.0.0
allow_anonymous true
```

Restart after editing:
```bash
brew services restart mosquitto
```

---

## Linux (Ubuntu / Debian)

### Node.js v22

Install Node.js 22 via the **NodeSource** repository (system-wide):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:
```bash
node --version
npm --version
```

**Managing multiple Node.js versions** — If you need to switch between Node.js versions across different projects, use [nvm](https://github.com/nvm-sh/nvm) instead:
```bash
sudo apt update && sudo apt install -y curl build-essential
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
nvm alias default 22
```

---

### PostgreSQL v17

> **Important:** Do not use `sudo apt install postgresql` — this installs the version bundled with your Ubuntu/Debian release (v14 or v16), not v17. You must add the official PGDG repository.

**Step 1 — Add the PGDG repository:**
```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
```

The script auto-detects your release codename and adds the correct repository source.

**Step 2 — Install PostgreSQL 17:**
```bash
sudo apt install -y postgresql-17
```

The service starts automatically. Verify:
```bash
sudo systemctl status postgresql
sudo -u postgres psql -c "SELECT version();"
```

---

### PostGIS

The PGDG repository (added above) provides the correct PostGIS package for PostgreSQL 17:

```bash
sudo apt install -y postgresql-17-postgis-3 postgresql-17-postgis-3-scripts
```

> **Note:** Do not use the plain `postgis` package from Ubuntu's default repositories — it may be built against a different PostgreSQL version.

Enable PostGIS in your database:
```bash
sudo -u postgres psql -d mobius4 -c "CREATE EXTENSION postgis;"
```

---

### Mosquitto

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```

**Required configuration** — Mosquitto v2+ rejects all connections without explicit configuration. Create the file `/etc/mosquitto/conf.d/default.conf`:
```bash
sudo tee /etc/mosquitto/conf.d/default.conf <<'EOF'
listener 1883 0.0.0.0
allow_anonymous true
EOF
```

Restart after creating the file:
```bash
sudo systemctl restart mosquitto
```

Verify:
```bash
mosquitto_sub -h localhost -t "test" &
mosquitto_pub -h localhost -t "test" -m "hello"
```
