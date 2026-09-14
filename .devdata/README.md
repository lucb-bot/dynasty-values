Test fixtures: real DynastyProcess CSVs, so `npm test` runs offline.
db_playerids.csv (2.6MB) is omitted to keep the zip small; the pipeline always
fetches a fresh copy at runtime. To run the tests, grab it once:
  curl -o .devdata/db_playerids.csv https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv
