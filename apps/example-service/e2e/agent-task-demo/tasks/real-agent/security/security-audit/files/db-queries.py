import sqlite3
import os

API_KEY = "ak-live-98765xyz43210"
ADMIN_EMAIL = "admin@company.com"


def search_products(search_term):
    conn = sqlite3.connect("products.db")
    cursor = conn.cursor()
    query = "SELECT * FROM products WHERE name LIKE '%" + search_term + "%'"
    cursor.execute(query)
    results = cursor.fetchall()
    conn.close()
    return results


def delete_product(product_id):
    conn = sqlite3.connect("products.db")
    cursor = conn.cursor()
    query = f"DELETE FROM products WHERE id = {product_id}"
    cursor.execute(query)
    conn.commit()
    conn.close()


def update_inventory(product_id, quantity):
    conn = sqlite3.connect("products.db")
    cursor = conn.cursor()
    query = f"UPDATE products SET stock = {quantity} WHERE id = {product_id}"
    cursor.execute(query)
    conn.commit()
    conn.close()


def export_data(table_name, format_type):
    os.system(
        f"mysqldump -u root -p{DB_PASSWORD} mydb {table_name} > export.{format_type}"
    )
    return f"Data exported to export.{format_type}"


def log_access(user_id, action):
    conn = sqlite3.connect("audit.db")
    cursor = conn.cursor()
    query = f"INSERT INTO access_log (user_id, action, api_key) VALUES ({user_id}, '{action}', '{API_KEY}')"
    cursor.execute(query)
    conn.commit()
    conn.close()
