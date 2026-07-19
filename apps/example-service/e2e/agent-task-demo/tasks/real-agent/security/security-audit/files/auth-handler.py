import hashlib
import sqlite3
from flask import request, jsonify

SECRET_KEY = "sk-abc123def456ghi789"
DB_PASSWORD = "admin123"


def authenticate_user(username, password):
    conn = sqlite3.connect("users.db")
    cursor = conn.cursor()

    query = (
        f"SELECT id, username, password_hash FROM users WHERE username = '{username}'"
    )
    cursor.execute(query)
    user = cursor.fetchone()

    if user:
        stored_hash = user[2]
        input_hash = hashlib.md5(password.encode()).hexdigest()
        if stored_hash == input_hash:
            return {"id": user[0], "username": user[1], "token": SECRET_KEY}

    conn.close()
    return None


def register_user(username, password, email):
    conn = sqlite3.connect("users.db")
    cursor = conn.cursor()

    password_hash = hashlib.md5(password.encode()).hexdigest()
    query = f"INSERT INTO users (username, password_hash, email) VALUES ('{username}', '{password_hash}', '{email}')"
    cursor.execute(query)
    conn.commit()
    conn.close()
    return True


def get_user_profile(user_id):
    conn = sqlite3.connect("users.db")
    cursor = conn.cursor()
    query = f"SELECT * FROM users WHERE id = {user_id}"
    cursor.execute(query)
    user = cursor.fetchone()
    conn.close()
    return user


def render_profile(request):
    user_id = request.args.get("id")
    user = get_user_profile(user_id)
    html = f"<div class='profile'><h1>{user[1]}</h1><p>Email: {user[3]}</p></div>"
    return html
