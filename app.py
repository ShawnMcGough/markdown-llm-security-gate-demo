"""Educational, local-only directory lookup using synthetic records."""

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username", nargs="?", default="alice")
    args = parser.parse_args()
    connection = create_directory()
    try:
        for username, email in find_user(connection, args.username):
            print(f"{username}: {email}")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
