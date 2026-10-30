# Node.js Deployment — Clone, Run & HTTPS

## 1. SSH into the Server

```bash
ssh root@YOUR_SERVER_IP
```

---

## 2. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v
npm -v
```

---

## 3. Clone the Repository

```bash
git clone https://github.com/USERNAME/REPOSITORY.git
cd REPOSITORY
```

---

## 4. Install Dependencies

```bash
npm install
```

---

## 5. Configure Environment Variables

Create the `.env` file:

```bash
nano .env
```

Add the required environment variables for the project, for example:

```ini
PORT=5968
OPENAI_API_KEY=your-openai-api-key
ADMIN_TOKEN=your-admin-token
```

Save with:

| Keys | Action |
| --- | --- |
| `Ctrl + O` | Write the file |
| `Enter` | Confirm the file name |
| `Ctrl + X` | Exit nano |

---

## 6. Run the Application

Start the application:

```bash
npm start
```

Test it:

```bash
curl http://127.0.0.1:5968/health
```

If it works, stop the server with `Ctrl + C`.

---

## 7. Install PM2

```bash
sudo npm install -g pm2
```

Start the application:

```bash
pm2 start npm --name gridbloom-backend -- start
```

Check:

```bash
pm2 status
```

Save the PM2 process:

```bash
pm2 save
```

Enable PM2 after reboot:

```bash
pm2 startup
```

Run the command printed by PM2, then:

```bash
pm2 save
```

---

## 8. Install Nginx

```bash
sudo apt update
sudo apt install -y nginx
```

---

## 9. Configure Nginx

Create the configuration:

```bash
sudo nano /etc/nginx/sites-available/gridbloom-backend
```

Add:

```nginx
server {
    listen 80;
    listen [::]:80;

    server_name gridbloombackend.oxmite.com;

    location / {
        proxy_pass http://127.0.0.1:5968;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Save and exit.

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/gridbloom-backend /etc/nginx/sites-enabled/gridbloom-backend
```

Test Nginx:

```bash
sudo nginx -t
```

Reload:

```bash
sudo systemctl reload nginx
```

---

## 10. Point the Domain to the Server

Create an **A record**:

| Field | Value |
| --- | --- |
| Type | `A` |
| Host | `gridbloombackend` |
| Value | `YOUR_SERVER_IP` |

Verify:

```bash
dig +short gridbloombackend.oxmite.com
```

It should return your server IP.

---

## 11. Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

---

## 12. Enable HTTPS

```bash
sudo certbot --nginx -d gridbloombackend.oxmite.com
```

Follow the prompts and select the option to redirect HTTP to HTTPS if asked.

---

## 13. Test HTTPS

```bash
curl https://gridbloombackend.oxmite.com/health
```

---

## 14. Test Certificate Renewal

```bash
sudo certbot renew --dry-run
```
