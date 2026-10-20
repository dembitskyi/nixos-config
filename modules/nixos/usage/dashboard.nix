{ lib, datasource }:
let
  ds = {
    type = "prometheus";
    uid = datasource;
  };
  ref = i: builtins.substring i 1 "ABCDEFGHIJKLMNOP";
  pos = x: y: w: h: {
    inherit
      x
      y
      w
      h
      ;
  };

  # Leaf systemd units and docker scopes (user@N.service only nests them).
  leaf = ''id=~`.+\.(service|scope)`, id!~`.*/user@[0-9]+\.service`'';
  unit = ''id="$cgroup"'';
  procs = ''cgroup="$cgroup"'';
  svc = e: "sum by (id, unit, group) (${e})";
  pss = sel: ''namedprocess_namegroup_memory_bytes{${sel}memtype="proportionalResident"}'';
  rss = sel: ''namedprocess_namegroup_memory_bytes{${sel}memtype="resident"}'';
  swapped = sel: ''namedprocess_namegroup_memory_bytes{${sel}memtype="swapped"}'';
  procRate = sel: metric: "rate(namedprocess_namegroup_${metric}{${sel}}[30s])";

  panel =
    type: title: gridPos: targets: extra:
    lib.recursiveUpdate {
      inherit type title gridPos;
      datasource = ds;
      targets = lib.imap0 (
        i: t:
        {
          refId = ref i;
          datasource = ds;
        }
        // t
      ) targets;
    } extra;

  series = expr: legendFormat: { inherit expr legendFormat; };
  instant = expr: {
    inherit expr;
    instant = true;
    range = false;
    format = "table";
  };

  thresholds = steps: {
    mode = "absolute";
    steps = lib.imap0 (i: s: {
      color = builtins.elemAt s 0;
      value = if i == 0 then null else builtins.elemAt s 1;
    }) steps;
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
  alarm = [
    [ "green" ]
    [
      "red"
      1
    ]
  ];

  stat =
    title: gridPos: expr: unit: steps: extra:
    panel "stat" title gridPos [ (series expr title) ] (
      lib.recursiveUpdate {
        fieldConfig.defaults = {
          inherit unit;
          decimals = 1;
          thresholds = thresholds steps;
        };
        options = {
          reduceOptions.calcs = [ "lastNotNull" ];
          graphMode = "area";
          colorMode = "value";
        };
      } extra
    );

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
  # Opens the service report for the row's cgroup.
  report = field: {
    id = "links";
    value = [
      {
        title = "Open service report";
        url = "/d/usage-service/usage-service?var-cgroup=\${__data.fields.${field}:percentencode}&kiosk";
      }
    ];
  };

  # Columns: [ title unit expr ]; the first is the default sort.
  table =
    title: gridPos: labels: columns: overrides:
    let
      names = lib.imap0 (i: c: {
        name = "Value #${ref i}";
        value = builtins.elemAt c 0;
      }) columns;
    in
    panel "table" title gridPos (map (c: instant (builtins.elemAt c 2)) columns) {
      transformations = [
        {
          id = "merge";
          options = { };
        }
        {
          id = "organize";
          options = {
            excludeByName.Time = true;
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
          width = 105;
        };
        overrides =
          map (
            c:
            label (builtins.elemAt c 0) [
              {
                id = "unit";
                value = builtins.elemAt c 1;
              }
              {
                id = "decimals";
                value = if builtins.elemAt c 1 == "none" then 0 else 1;
              }
              {
                id = "custom.width";
                value =
                  if builtins.elemAt c 1 == "dateTimeFromNow" then
                    140
                  else if builtins.stringLength (builtins.elemAt c 0) > 10 then
                    145
                  else
                    105;
              }
            ]
          ) columns
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

  memOf = sel: "container_memory_rss{${sel}} + container_memory_swap{${sel}}";
  memAtEnd = sel: "container_memory_rss{${sel}} @ end() + container_memory_swap{${sel}} @ end()";
  base = {
    tags = [ "usage" ];
    editable = false;
    schemaVersion = 41;
    refresh = "5s";
  };
in
{
  usage = base // {
    uid = "usage";
    title = "Usage";
    time = {
      from = "now-1h";
      to = "now";
    };
    panels = [
      (stat "CPU" (pos 0 0 4 4)
        ''100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])))''
        "percent"
        pct
        { }
      )
      (stat "Memory in use" (pos 4 0 4
        4
      ) "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes" "bytes" calm { })
      (stat "Available" (pos 8 0 4 4) "node_memory_MemAvailable_bytes" "bytes" calm { })
      (stat "Swap in use" (pos 12 0 4
        4
      ) "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes" "bytes" calm { })
      (stat "Memory stall" (pos 16 0 4
        4
      ) "100 * rate(node_pressure_memory_waiting_seconds_total[$__rate_interval])" "percent" pct { })
      (stat "I/O stall" (pos 20 0 4
        4
      ) "100 * rate(node_pressure_io_waiting_seconds_total[$__rate_interval])" "percent" pct { })

      (timeseries "Memory" (pos 0 4 12 8)
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
              (label "Swap in use" [
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
              ])
            ];
          }
        )
      )
      (timeseries "CPU by mode" (pos 12 4 12 8) [
        (series ''100 * sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[$__rate_interval])) / scalar(count(node_cpu_seconds_total{mode="idle"}))'' "{{mode}}")
      ] "percent" stacked)

      (table "Services (click one for its report)" (pos 0 12 24 14)
        [
          "unit"
          "group"
          "id"
        ]
        [
          [
            "Memory"
            "bytes"
            (svc (memOf leaf))
          ]
          [
            "RAM"
            "bytes"
            (svc "container_memory_rss{${leaf}}")
          ]
          [
            "Swap"
            "bytes"
            (svc "container_memory_swap{${leaf}}")
          ]
          [
            "File cache"
            "bytes"
            (svc "container_memory_cache{${leaf}}")
          ]
          [
            "CPU %"
            "percent"
            (svc "100 * rate(container_cpu_usage_seconds_total{${leaf}}[30s])")
          ]
          [
            "Read/s"
            "Bps"
            (svc "rate(container_fs_reads_bytes_total{${leaf}}[30s])")
          ]
          [
            "Write/s"
            "Bps"
            (svc "rate(container_fs_writes_bytes_total{${leaf}}[30s])")
          ]
          [
            "Procs"
            "none"
            (svc "container_processes{${leaf}}")
          ]
          [
            "Threads"
            "none"
            (svc "container_threads{${leaf}}")
          ]
          [
            "Mem stall %"
            "percent"
            (svc "100 * rate(container_pressure_memory_waiting_seconds_total{${leaf}}[30s])")
          ]
        ]
        [
          (hidden "id")
          (titled "unit" "Service" 320 [ (report "id") ])
          (titled "group" "Group" 120 [ ])
        ]
      )

      (timeseries "Top 10 services: memory (RAM + swap)" (pos 0 26 12 9) [
        (series (svc "(${memOf leaf}) and on(id) topk(10, ${memAtEnd leaf})") "{{unit}}")
      ] "bytes" { })
      (timeseries "Top 10 services: CPU (% of one core)" (pos 12 26 12 9) [
        (series (svc "100 * rate(container_cpu_usage_seconds_total{${leaf}}[$__rate_interval]) and on(id) topk(10, rate(container_cpu_usage_seconds_total{${leaf}}[5m] @ end()))") "{{unit}}")
      ] "percent" { })

      (table "Programs (click one for its service report)" (pos 0 35 24 16)
        [
          "program"
          "unit"
          "cgroup"
        ]
        (
          let
            by = e: "sum by (cgroup, unit, program) (${e})";
          in
          [
            [
              "Memory (PSS)"
              "bytes"
              (by (pss ""))
            ]
            [
              "RSS"
              "bytes"
              (by (rss ""))
            ]
            [
              "Swap"
              "bytes"
              (by (swapped ""))
            ]
            [
              "CPU %"
              "percent"
              "100 * ${by (procRate "" "cpu_seconds_total")}"
            ]
            [
              "Procs"
              "none"
              "count by (cgroup, unit, program) (namedprocess_namegroup_num_threads)"
            ]
            [
              "Threads"
              "none"
              (by "namedprocess_namegroup_num_threads")
            ]
          ]
        )
        [
          (hidden "cgroup")
          (titled "program" "Program" 220 [ (report "cgroup") ])
          (titled "unit" "Service" 320 [ (report "cgroup") ])
        ]
      )
    ];
  };

  usage-service = base // {
    uid = "usage-service";
    title = "Service report";
    time = {
      from = "now-15m";
      to = "now";
    };
    links = [
      {
        title = "All services";
        type = "link";
        icon = "dashboard";
        url = "/d/usage/usage?kiosk";
      }
    ];
    templating.list = [
      {
        name = "cgroup";
        label = "Service";
        type = "query";
        datasource = ds;
        query = {
          query = "label_values(container_memory_usage_bytes{${leaf}}, id)";
          refId = "cgroup";
        };
        regex = "/(?<value>.*\\/(?<text>[^\\/]+))/";
        refresh = 2;
        sort = 5;
        current = { };
      }
    ];
    panels = [
      (panel "stat" "Service" (pos 0 0 6 4)
        [ (series "max by (unit, group) (container_last_seen{${unit}})" "{{unit}}  ·  {{group}}") ]
        {
          options = {
            reduceOptions.calcs = [ "lastNotNull" ];
            textMode = "name";
            graphMode = "none";
            colorMode = "none";
          };
        }
      )
      (stat "RAM + swap" (pos 6 0 3 4) "sum(${memOf unit})" "bytes" calm { })
      (stat "RAM" (pos 9 0 3 4) "sum(container_memory_rss{${unit}})" "bytes" calm { })
      (stat "Swap" (pos 12 0 3 4) "sum(container_memory_swap{${unit}})" "bytes" calm { })
      (stat "File cache" (pos 15 0 3 4) "sum(container_memory_cache{${unit}})" "bytes" calm { })
      (stat "CPU %" (pos 18 0 3 4)
        "100 * sum(rate(container_cpu_usage_seconds_total{${unit}}[$__rate_interval]))"
        "percent"
        calm
        { }
      )
      (stat "Processes" (pos 21 0 3 4) "sum(container_processes{${unit}})" "none" calm {
        fieldConfig.defaults.decimals = 0;
      })

      (stat "Threads" (pos 0 4 3 4) "sum(container_threads{${unit}})" "none" calm {
        fieldConfig.defaults.decimals = 0;
      })
      (stat "Peak memory" (pos 3 4 3 4) "max(container_memory_max_usage_bytes{${unit}})" "bytes" calm { })
      (stat "Memory limit" (pos 6 4 3 4) "max(container_spec_memory_limit_bytes{${unit}})" "bytes" calm {
        fieldConfig.defaults.mappings = [
          {
            type = "value";
            options."0".text = "none";
          }
        ];
      })
      (stat "Memory stall" (pos 9 4 3 4)
        "100 * sum(rate(container_pressure_memory_waiting_seconds_total{${unit}}[$__rate_interval]))"
        "percent"
        pct
        { }
      )
      (stat "CPU stall" (pos 12 4 3 4)
        "100 * sum(rate(container_pressure_cpu_waiting_seconds_total{${unit}}[$__rate_interval]))"
        "percent"
        pct
        { }
      )
      (stat "I/O stall" (pos 15 4 3 4)
        "100 * sum(rate(container_pressure_io_waiting_seconds_total{${unit}}[$__rate_interval]))"
        "percent"
        pct
        { }
      )
      (stat "OOM kills" (pos 18 4 3 4) "max(container_oom_events_total{${unit}})" "none" alarm {
        fieldConfig.defaults.decimals = 0;
      })
      (stat "Running for" (pos 21 4 3 4) "time() - max(container_start_time_seconds{${unit}})" "s" calm {
        options.graphMode = "none";
      })

      (timeseries "Memory" (pos 0 8 8 9) [
        (series "sum(container_memory_rss{${unit}})" "RAM")
        (series "sum(container_memory_swap{${unit}})" "Swap")
        (series "sum(container_memory_cache{${unit}})" "File cache")
        (series "sum(container_memory_kernel_usage{${unit}})" "Kernel")
      ] "bytes" (narrow stacked))
      (timeseries "CPU (% of one core)" (pos 8 8 8 9) [
        (series "100 * sum(rate(container_cpu_user_seconds_total{${unit}}[$__rate_interval]))" "user")
        (series "100 * sum(rate(container_cpu_system_seconds_total{${unit}}[$__rate_interval]))" "system")
      ] "percent" (narrow stacked))
      (timeseries "Memory by program (PSS)" (pos 16 8 8 9) [
        (series "sum by (program) (${pss "${procs}, "}) and on(program) topk(8, sum by (program) (${pss "${procs}, "} @ end()))" "{{program}}")
      ] "bytes" (narrow stacked))
      (timeseries "CPU by program (% of one core)" (pos 0 17 8 8) [
        (series "100 * sum by (program) (${procRate procs "cpu_seconds_total"}) and on(program) topk(8, sum by (program) (rate(namedprocess_namegroup_cpu_seconds_total{${procs}}[2m] @ end())))" "{{program}}")
      ] "percent" (narrow stacked))
      (timeseries "Disk I/O" (pos 8 17 8 8)
        [
          (series "sum(rate(container_fs_reads_bytes_total{${unit}}[$__rate_interval]))" "read")
          (series "sum(rate(container_fs_writes_bytes_total{${unit}}[$__rate_interval]))" "write")
        ]
        "Bps"
        (narrow {
          fieldConfig.defaults.noValue = "Not tracked (user units have no I/O controller)";
        })
      )
      (timeseries "Stall (time waiting for a resource)" (pos 16 17 8 8) [
        (series "100 * sum(rate(container_pressure_cpu_waiting_seconds_total{${unit}}[$__rate_interval]))" "CPU")
        (series "100 * sum(rate(container_pressure_memory_waiting_seconds_total{${unit}}[$__rate_interval]))" "memory")
        (series "100 * sum(rate(container_pressure_io_waiting_seconds_total{${unit}}[$__rate_interval]))" "I/O")
      ] "percent" (narrow { }))

      (table "Processes" (pos 0 25 24 16)
        [
          "pid"
          "user"
          "program"
          "args"
        ]
        (
          let
            by = e: "sum by (pid, user, program, args) (${e})";
          in
          [
            [
              "Memory (PSS)"
              "bytes"
              (by (pss "${procs}, "))
            ]
            [
              "RSS"
              "bytes"
              (by (rss "${procs}, "))
            ]
            [
              "Swap"
              "bytes"
              (by (swapped "${procs}, "))
            ]
            [
              "CPU %"
              "percent"
              "100 * ${by (procRate procs "cpu_seconds_total")}"
            ]
            [
              "Threads"
              "none"
              (by "namedprocess_namegroup_num_threads{${procs}}")
            ]
            [
              "Read/s"
              "Bps"
              (by (procRate procs "read_bytes_total"))
            ]
            [
              "Write/s"
              "Bps"
              (by (procRate procs "write_bytes_total"))
            ]
            [
              "Started"
              "dateTimeFromNow"
              "1000 * ${by "namedprocess_namegroup_oldest_start_time_seconds{${procs}}"}"
            ]
          ]
        )
        [
          (titled "pid" "PID" 80 [ ])
          (titled "user" "User" 130 [ ])
          (titled "program" "Program" 170 [ ])
          (titled "args" "Arguments" 260 [ ])
        ]
      )
    ];
  };
}
