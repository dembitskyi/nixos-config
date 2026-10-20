{ lib, datasource }:
let
  ds = {
    type = "prometheus";
    uid = datasource;
  };

  # Leaf systemd units and docker scopes (user@N.service only nests them).
  leaf = ''id=~`.+\.(service|scope)`, id!~`.*/user@[0-9]+\.service`'';
  unit = ''id="$unit"'';
  inUnit = "groupname=~`\\[\${unit:regex}\\]\\|.*`";

  bySvc =
    e:
    ''label_replace(label_replace(label_replace(sum by (id, name) (${e}), "service", "$1", "id", `.*/([^/]+)$`), "service", "$1 (docker)", "name", "(.+)"), "group", "$1", "id", `.*/([^/]+)/[^/]+$`)'';
  byProc =
    e:
    ''label_replace(label_replace(label_replace(sum by (groupname) (${e}), "service", "$1", "groupname", `\[(?:.*/)?([^/]*)\]\|.*`), "program", "$1", "groupname", `[^|]*\|([^|]*)\|.*`), "comm", "$1", "groupname", `.*\|([^|]*)$`)'';

  procMem = sel: memtype: ''namedprocess_namegroup_memory_bytes{${sel}memtype="${memtype}"}'';
  procRate = sel: metric: "rate(namedprocess_namegroup_${metric}{${sel}}[1m])";

  target =
    i: t:
    {
      refId = builtins.substring i 1 "ABCDEFGHIJKLMNOP";
      datasource = ds;
    }
    // t;

  panel =
    type: title: gridPos: targets: extra:
    lib.recursiveUpdate {
      inherit type title gridPos;
      datasource = ds;
      targets = lib.imap0 target targets;
    } extra;

  series = expr: legendFormat: { inherit expr legendFormat; };
  column = expr: {
    inherit expr;
    instant = true;
    range = false;
    format = "table";
  };

  stat =
    title: x: expr: unit: steps:
    panel "stat" title
      {
        inherit x;
        y = 0;
        w = 4;
        h = 4;
      }
      [ (series expr title) ]
      {
        fieldConfig.defaults = {
          inherit unit;
          decimals = 1;
          thresholds = {
            mode = "absolute";
            steps = lib.imap0 (i: s: {
              color = builtins.elemAt s 0;
              value = if i == 0 then null else builtins.elemAt s 1;
            }) steps;
          };
        };
        options = {
          reduceOptions.calcs = [ "lastNotNull" ];
          graphMode = "area";
          colorMode = "value";
        };
      };
  calm = [ [ "text" ] ];
  pct = [
    [ "green" ]
    [
      "orange"
      30
    ]
    [
      "red"
      70
    ]
  ];

  timeseries =
    title: gridPos: targets: unit: extra:
    panel "timeseries" title gridPos targets (
      lib.recursiveUpdate {
        fieldConfig.defaults = {
          inherit unit;
          min = 0;
          custom = {
            fillOpacity = 15;
            lineWidth = 1;
            showPoints = "never";
          };
        };
        options = {
          legend = {
            displayMode = "table";
            placement = "right";
            calcs = [
              "lastNotNull"
              "max"
            ];
          };
          tooltip = {
            mode = "multi";
            sort = "desc";
          };
        };
      } extra
    );
  stacked = {
    fieldConfig.defaults.custom.stacking.mode = "normal";
  };
  narrow = extra: lib.recursiveUpdate { options.legend.placement = "bottom"; } extra;

  # Columns: [ title unit expr ]; the first is the default sort.
  table =
    title: gridPos: labels: columns: overrides:
    let
      names = lib.imap0 (i: c: {
        name = "Value #${builtins.substring i 1 "ABCDEFGHIJKLMNOP"}";
        value = builtins.elemAt c 0;
      }) columns;
    in
    panel "table" title gridPos (map (c: column (builtins.elemAt c 2)) columns) {
      transformations = [
        {
          id = "merge";
          options = { };
        }
        {
          id = "organize";
          options = {
            excludeByName = {
              Time = true;
              name = true;
              groupname = true;
            };
            renameByName = lib.listToAttrs names;
            indexByName = lib.listToAttrs (
              lib.imap0 (i: n: lib.nameValuePair n i) (labels ++ map (n: n.name) names)
            );
          };
        }
      ];
      fieldConfig = {
        defaults.custom = {
          align = "auto";
          filterable = true;
          width = 112;
        };
        overrides =
          map (c: {
            matcher = {
              id = "byName";
              options = builtins.elemAt c 0;
            };
            properties = [
              {
                id = "unit";
                value = builtins.elemAt c 1;
              }
              {
                id = "decimals";
                value = if builtins.elemAt c 1 == "none" then 0 else 1;
              }
            ];
          }) columns
          ++ overrides;
      };
      options = {
        showHeader = true;
        cellHeight = "sm";
        sortBy = [
          {
            displayName = builtins.elemAt (builtins.head columns) 0;
            desc = true;
          }
        ];
      };
    };

  label = name: properties: {
    matcher = {
      id = "byName";
      options = name;
    };
    inherit properties;
  };
  hidden =
    name:
    label name [
      {
        id = "custom.hidden";
        value = true;
      }
    ];
  titled =
    name: displayName: width: extra:
    label name (
      [
        {
          id = "displayName";
          value = displayName;
        }
        {
          id = "custom.width";
          value = width;
        }
      ]
      ++ extra
    );

  procColumns = sel: [
    [
      "Memory (PSS)"
      "bytes"
      (byProc (procMem sel "proportionalResident"))
    ]
    [
      "RSS"
      "bytes"
      (byProc (procMem sel "resident"))
    ]
    [
      "Swap"
      "bytes"
      (byProc (procMem sel "proportionalSwapped"))
    ]
    [
      "CPU %"
      "percent"
      (byProc "100 * ${procRate sel "cpu_seconds_total"}")
    ]
    [
      "Procs"
      "none"
      (byProc "namedprocess_namegroup_num_procs{${sel}}")
    ]
    [
      "Threads"
      "none"
      (byProc "namedprocess_namegroup_num_threads{${sel}}")
    ]
    [
      "Read/s"
      "Bps"
      (byProc (procRate sel "read_bytes_total"))
    ]
    [
      "Write/s"
      "Bps"
      (byProc (procRate sel "write_bytes_total"))
    ]
  ];

  procLabels = [
    (titled "program" "Program" 200 [ ])
    (titled "comm" "Name" 150 [ ])
  ];

  memOf = sel: "container_memory_rss{${sel}} + container_memory_swap{${sel}}";
  memAtEnd = sel: "container_memory_rss{${sel}} @ end() + container_memory_swap{${sel}} @ end()";
in
{
  uid = "usage";
  title = "Usage";
  tags = [ "usage" ];
  editable = false;
  schemaVersion = 41;
  refresh = "10s";
  time = {
    from = "now-1h";
    to = "now";
  };

  templating.list = [
    {
      name = "unit";
      label = "Service";
      type = "query";
      datasource = ds;
      query = {
        query = "label_values(container_memory_usage_bytes{${leaf}}, id)";
        refId = "unit";
      };
      regex = "/(?<value>.*\\/(?<text>[^\\/]+))/";
      refresh = 2;
      sort = 5;
      current = { };
    }
  ];

  panels = [
    (stat "CPU" 0 ''100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])))''
      "percent"
      pct
    )
    (stat "Memory in use" 4 "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes" "bytes" calm)
    (stat "Available" 8 "node_memory_MemAvailable_bytes" "bytes" calm)
    (stat "Swap in use" 12 "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes" "bytes" calm)
    (stat "Memory stall" 16 "100 * rate(node_pressure_memory_waiting_seconds_total[$__rate_interval])"
      "percent"
      pct
    )
    (stat "I/O stall" 20 "100 * rate(node_pressure_io_waiting_seconds_total[$__rate_interval])"
      "percent"
      pct
    )

    (timeseries "Memory"
      {
        x = 0;
        y = 4;
        w = 12;
        h = 8;
      }
      [
        (series "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes" "In use")
        (series "node_memory_MemAvailable_bytes - node_memory_MemFree_bytes" "Reclaimable cache")
        (series "node_memory_MemFree_bytes" "Free")
        (series "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes" "Swap in use")
      ]
      "bytes"
      (
        lib.recursiveUpdate stacked {
          fieldConfig.overrides = [
            {
              matcher = {
                id = "byName";
                options = "Swap in use";
              };
              properties = [
                {
                  id = "custom.stacking";
                  value.mode = "none";
                }
                {
                  id = "custom.fillOpacity";
                  value = 0;
                }
                {
                  id = "custom.lineWidth";
                  value = 2;
                }
              ];
            }
          ];
        }
      )
    )
    (timeseries "CPU by mode"
      {
        x = 12;
        y = 4;
        w = 12;
        h = 8;
      }
      [
        (series ''100 * sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[$__rate_interval])) / scalar(count(node_cpu_seconds_total{mode="idle"}))'' "{{mode}}")
      ]
      "percent"
      stacked
    )

    (table "Services (click one for details below)"
      {
        x = 0;
        y = 12;
        w = 24;
        h = 14;
      }
      [
        "service"
        "group"
        "id"
      ]
      [
        [
          "Memory"
          "bytes"
          (bySvc (memOf leaf))
        ]
        [
          "RAM"
          "bytes"
          (bySvc "container_memory_rss{${leaf}}")
        ]
        [
          "Swap"
          "bytes"
          (bySvc "container_memory_swap{${leaf}}")
        ]
        [
          "File cache"
          "bytes"
          (bySvc "container_memory_cache{${leaf}}")
        ]
        [
          "CPU %"
          "percent"
          (bySvc "100 * rate(container_cpu_usage_seconds_total{${leaf}}[1m])")
        ]
        [
          "Read/s"
          "Bps"
          (bySvc "rate(container_fs_reads_bytes_total{${leaf}}[1m])")
        ]
        [
          "Write/s"
          "Bps"
          (bySvc "rate(container_fs_writes_bytes_total{${leaf}}[1m])")
        ]
        [
          "Procs"
          "none"
          (bySvc "container_processes{${leaf}}")
        ]
        [
          "Mem stall %"
          "percent"
          (bySvc "100 * rate(container_pressure_memory_waiting_seconds_total{${leaf}}[1m])")
        ]
      ]
      [
        (hidden "id")
        (titled "service" "Service" 320 [
          {
            id = "links";
            value = [
              {
                title = "Show details";
                url = "/d/usage/usage?var-unit=\${__data.fields.id:percentencode}&\${__url_time_range}&kiosk";
              }
            ];
          }
        ])
        (titled "group" "Group" 120 [ ])
      ]
    )

    (timeseries "Top 10 services: memory (RAM + swap)"
      {
        x = 0;
        y = 26;
        w = 12;
        h = 9;
      }
      [ (series (bySvc "(${memOf leaf}) and on(id) topk(10, ${memAtEnd leaf})") "{{service}}") ]
      "bytes"
      { }
    )
    (timeseries "Top 10 services: CPU (% of one core)"
      {
        x = 12;
        y = 26;
        w = 12;
        h = 9;
      }
      [
        (series (bySvc "100 * rate(container_cpu_usage_seconds_total{${leaf}}[$__rate_interval]) and on(id) topk(10, rate(container_cpu_usage_seconds_total{${leaf}}[5m] @ end()))") "{{service}}")
      ]
      "percent"
      { }
    )

    {
      type = "row";
      title = "Service: $unit";
      collapsed = false;
      gridPos = {
        x = 0;
        y = 35;
        w = 24;
        h = 1;
      };
      panels = [ ];
    }
    (timeseries "Memory"
      {
        x = 0;
        y = 36;
        w = 6;
        h = 10;
      }
      [
        (series "container_memory_rss{${unit}}" "RAM")
        (series "container_memory_swap{${unit}}" "Swap")
        (series "container_memory_cache{${unit}}" "File cache")
        (series "container_memory_kernel_usage{${unit}}" "Kernel")
      ]
      "bytes"
      (narrow stacked)
    )
    (timeseries "CPU (% of one core)"
      {
        x = 6;
        y = 36;
        w = 6;
        h = 10;
      }
      [
        (series "100 * rate(container_cpu_user_seconds_total{${unit}}[$__rate_interval])" "user")
        (series "100 * rate(container_cpu_system_seconds_total{${unit}}[$__rate_interval])" "system")
      ]
      "percent"
      (narrow stacked)
    )
    (timeseries "Disk I/O"
      {
        x = 12;
        y = 36;
        w = 6;
        h = 10;
      }
      [
        (series "sum(rate(container_fs_reads_bytes_total{${unit}}[$__rate_interval]))" "read")
        (series "sum(rate(container_fs_writes_bytes_total{${unit}}[$__rate_interval]))" "write")
      ]
      "Bps"
      (narrow {
        fieldConfig.defaults.noValue = "Not tracked (user units have no I/O controller)";
      })
    )
    (timeseries "Stall (time waiting for a resource)"
      {
        x = 18;
        y = 36;
        w = 6;
        h = 10;
      }
      [
        (series "100 * rate(container_pressure_cpu_waiting_seconds_total{${unit}}[$__rate_interval])" "CPU")
        (series "100 * rate(container_pressure_memory_waiting_seconds_total{${unit}}[$__rate_interval])" "memory")
        (series "100 * rate(container_pressure_io_waiting_seconds_total{${unit}}[$__rate_interval])" "I/O")
      ]
      "percent"
      (narrow { })
    )
    (table "Processes in $unit"
      {
        x = 0;
        y = 46;
        w = 24;
        h = 10;
      }
      [
        "program"
        "comm"
      ]
      (procColumns "${inUnit}, ")
      (procLabels ++ [ (hidden "service") ])
    )

    (table "All processes"
      {
        x = 0;
        y = 56;
        w = 24;
        h = 16;
      }
      [
        "program"
        "comm"
        "service"
      ]
      (procColumns "")
      (procLabels ++ [ (titled "service" "Service" 280 [ ]) ])
    )
  ];
}
