"""INTENTIONALLY INSECURE EDUCATIONAL EXAMPLE. Never deploy to production.

Local-only directory lookup using synthetic records.
"""

import argparse
import sqlite3


def create_directory():
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE users (username TEXT, email TEXT)")
    connection.executemany(
        "INSERT INTO users VALUES (?, ?)",
        [("alice", "alice@example.test"), ("bob", "bob@example.test")],
    )
    return connection


def find_user(connection, username):
    return connection.execute(
        "SELECT username, email FROM users WHERE username = ?", (username,)
    ).fetchall()


def find_by_email(connection, email):
    return connection.execute(
        f"SELECT username, email FROM users WHERE email = '{email}'"
    ).fetchall()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username", nargs="?", default="alice")
    parser.add_argument("--email", help="Look up a synthetic record by email")
    args = parser.parse_args()
    connection = create_directory()
    try:
        rows = (
            find_by_email(connection, args.email)
            if args.email is not None
            else find_user(connection, args.username)
        )
        for username, email in rows:
            print(f"{username}: {email}")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
