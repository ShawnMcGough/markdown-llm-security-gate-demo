"""Functional tests for the baseline, not the LLM gate's detection mechanism."""

import unittest

from app import create_directory, find_user


class DirectoryTests(unittest.TestCase):
    def setUp(self):
        self.connection = create_directory()
        self.addCleanup(self.connection.close)

    def test_exact_lookup(self):
        self.assertEqual(
            find_user(self.connection, "alice"), [("alice", "alice@example.test")]
        )

    def test_unknown_user(self):
        self.assertEqual(find_user(self.connection, "unknown"), [])

    def test_input_stays_a_value(self):
        self.assertEqual(find_user(self.connection, "' OR '1'='1"), [])


if __name__ == "__main__":
    unittest.main()
