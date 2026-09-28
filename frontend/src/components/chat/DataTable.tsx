interface DataTableProps {
  rows: Record<string, unknown>[];
}

export function DataTable({ rows }: DataTableProps) {
  if (!rows || rows.length === 0) {
    return (
      <p className="empty-data">
        No data returned.
      </p>
    );
  }

  if (typeof rows[0] !== "object") {
    return <p>{JSON.stringify(rows)}</p>;
  }

  const headers = Object.keys(rows[0]);

  return (
    <div className="data-table-container">
      <div className="data-table-toolbar">
        <div className="data-table-title-group">
          <span className="data-table-dot" />
          <span className="data-table-title">QUERY RESULTS</span>
        </div>
        <span className="data-table-count-badge">
          {rows.length} {rows.length === 1 ? "RECORD" : "RECORDS"}
        </span>
      </div>
      <div className="data-table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                {headers.map((h) => {
                  const val = row[h];
                  return (
                    <td key={h}>
                      {val === null ? (
                        <span className="null-indicator">NULL</span>
                      ) : (
                        String(val)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
