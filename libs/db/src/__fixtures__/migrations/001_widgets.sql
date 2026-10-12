-- Up Migration
CREATE TABLE widgets (id int PRIMARY KEY, name text NOT NULL);

-- Down Migration
DROP TABLE widgets;
