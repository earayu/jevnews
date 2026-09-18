"""Validate the actual migration independently with SQLite, not generated SQL."""
import pathlib
import sqlite3
import unittest

class SchemaTests(unittest.TestCase):
    def setUp(self):
        root = pathlib.Path(__file__).parents[1]
        self.assertEqual((root / 'migrations/0001_initial.sql').read_bytes(), (root / 'docs/architecture/cloudflare-schema.sql').read_bytes())
        self.db = sqlite3.connect(':memory:')
        self.db.executescript((root / 'migrations/0001_initial.sql').read_text())
    def test_foreign_keys(self):
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO sessions VALUES('t','missing','csrf',1)")
    def test_case_insensitive_username(self):
        self.db.execute("INSERT INTO users VALUES('1','Alice','hash','recovery',0)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO users VALUES('2','alice','hash','recovery',0)")
    def test_atomic_budget(self):
        sql = 'INSERT INTO budgets VALUES(?,?,?) ON CONFLICT(day,scope) DO UPDATE SET amount=amount+excluded.amount WHERE amount+excluded.amount<=? RETURNING amount'
        self.assertEqual(self.db.execute(sql,('day','tokens',4,7)).fetchone(),(4,))
        self.assertIsNone(self.db.execute(sql,('day','tokens',4,7)).fetchone())
    def test_rule_cap(self):
        self.db.execute("INSERT INTO users VALUES('1','Alice','hash','recovery',0)")
        for i in range(3):
            self.db.execute("INSERT INTO private_rules(id,owner_id,name,prompt,compiled_json,created_at) VALUES(?,?,?,?,?,?)",(str(i),'1','rule','','{}',0))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO private_rules(id,owner_id,name,prompt,compiled_json,created_at) VALUES('four','1','rule','','{}',0)")

if __name__ == '__main__':
    unittest.main(verbosity=2)
