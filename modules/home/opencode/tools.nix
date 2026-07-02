{
  taskTool = {
    task = true;
  };

  readTools = {
    glob = true;
    grep = true;
    list = true;
    read = true;
    todoread = true;
  };

  disableSkill = {
    skill = false;
  };

  writeTools = {
    bash = true;
    edit = true;
    patch = true;
    todowrite = true;
    write = true;
  };

  # Read-only subset of git MCP tools.
  gitReadMcp = {
    "mcp_git_git_status" = true;
    "mcp_git_git_diff_unstaged" = true;
    "mcp_git_git_diff_staged" = true;
    "mcp_git_git_diff" = true;
    "mcp_git_git_log" = true;
    "mcp_git_git_show" = true;
    "mcp_git_git_branch" = true;
  };

  githubMcpSearch = {
    "mcp_github_get_commit" = true;
    "mcp_github_get_me" = true;
    "mcp_github_issue_read" = true;
    "mcp_github_list_branches" = true;
    "mcp_github_list_commits" = true;
    "mcp_github_list_issue_types" = true;
    "mcp_github_list_issues" = true;
    "mcp_github_list_pull_requests" = true;
    "mcp_github_list_releases" = true;
    "mcp_github_search_code" = true;
    "mcp_github_search_issues" = true;
    "mcp_github_search_pull_requests" = true;
    "mcp_github_search_repositories" = true;
    "mcp_github_search_users" = true;
    "mcp_github_get_file_contents" = true;
    "mcp_github_get_issue" = true;
    "mcp_github_get_pull_request_comments" = true;
    "mcp_github_get_pull_request_reviews" = true;
    "mcp_github_get_pull_request" = true;
    "mcp_github_get_pull_request_files" = true;
    "mcp_github_get_pull_request_status" = true;
  };

  githubMcpWrite = {
    "mcp_github_add_comment_to_pending_review" = true;
    "mcp_github_add_issue_comment" = true;
    "mcp_github_add_reply_to_pull_request_comment" = true;
    "mcp_github_assign_copilot_to_issue" = true;
    "mcp_github_create_branch" = true;
    "mcp_github_create_pull_request_review" = true;
    "mcp_github_create_or_update_file" = true;
    "mcp_github_create_pull_request" = true;
    "mcp_github_create_repository" = true;
    "mcp_github_delete_file" = true;
    "mcp_github_fork_repository" = true;
    "mcp_github_issue_write" = true;
    "mcp_github_merge_pull_request" = true;
    "mcp_github_pull_request_review_write" = true;
    "mcp_github_push_files" = true;
    "mcp_github_request_copilot_review" = true;
    "mcp_github_sub_issue_write" = true;
    "mcp_github_update_pull_request" = true;
    "mcp_github_update_pull_request_branch" = true;
    "mcp_github_update_issue" = true;
  };

  githubMcpMisc = {
    "mcp_github_get_label" = true;
    "mcp_github_get_latest_release" = true;
    "mcp_github_get_release_by_tag" = true;
    "mcp_github_get_tag" = true;
    "mcp_github_list_tags" = true;
  };

  timeMcp = {
    "mcp_time_get_current_time" = true;
    "mcp_time_convert_time" = true;
  };

  gitMcp = {
    "mcp_git_git_status" = true;
    "mcp_git_git_diff_unstaged" = true;
    "mcp_git_git_diff_staged" = true;
    "mcp_git_git_diff" = true;
    "mcp_git_git_commit" = true;
    "mcp_git_git_add" = true;
    "mcp_git_git_reset" = true;
    "mcp_git_git_log" = true;
    "mcp_git_git_create_branch" = true;
    "mcp_git_git_checkout" = true;
    "mcp_git_git_show" = true;
    "mcp_git_git_branch" = true;
  };

  fetchMcp = {
    "mcp_fetch_fetch" = true;
  };
  nixosMcp = {
    "mcp_nixos_nix" = true;
    "mcp_nixos_nix_versions" = true;
  };

  context7Mcp = {
    "mcp_context7_resolve-library-id" = true;
    "mcp_context7_query-docs" = true;
  };

  sessionId = {
    "session-id" = true;
  };

  aiSearch = {
    "ai-search" = true;
  };

  memoryMcp = {
    "mcp_memory_create_entities" = true;
    "mcp_memory_create_relations" = true;
    "mcp_memory_add_observations" = true;
    "mcp_memory_delete_entities" = true;
    "mcp_memory_delete_observations" = true;
    "mcp_memory_delete_relations" = true;
    "mcp_memory_read_graph" = true;
    "mcp_memory_search_nodes" = true;
    "mcp_memory_open_nodes" = true;
  };
  jiraMcp = {
    "mcp_jira_jira_get_user_profile" = true;
    "mcp_jira_jira_get_issue_watchers" = true;
    "mcp_jira_jira_add_watcher" = true;
    "mcp_jira_jira_remove_watcher" = true;
    "mcp_jira_jira_get_issue" = true;
    "mcp_jira_jira_search" = true;
    "mcp_jira_jira_search_fields" = true;
    "mcp_jira_jira_get_field_options" = true;
    "mcp_jira_jira_get_project_issues" = true;
    "mcp_jira_jira_get_transitions" = true;
    "mcp_jira_jira_get_worklog" = true;
    "mcp_jira_jira_download_attachments" = true;
    "mcp_jira_jira_get_issue_images" = true;
    "mcp_jira_jira_get_agile_boards" = true;
    "mcp_jira_jira_get_board_issues" = true;
    "mcp_jira_jira_get_sprints_from_board" = true;
    "mcp_jira_jira_get_sprint_issues" = true;
    "mcp_jira_jira_get_link_types" = true;
    "mcp_jira_jira_create_issue" = true;
    "mcp_jira_jira_batch_create_issues" = true;
    "mcp_jira_jira_batch_get_changelogs" = true;
    "mcp_jira_jira_update_issue" = true;
    "mcp_jira_jira_delete_issue" = true;
    "mcp_jira_jira_add_comment" = true;
    "mcp_jira_jira_edit_comment" = true;
    "mcp_jira_jira_add_worklog" = true;
    "mcp_jira_jira_link_to_epic" = true;
    "mcp_jira_jira_create_issue_link" = true;
    "mcp_jira_jira_create_remote_issue_link" = true;
    "mcp_jira_jira_remove_issue_link" = true;
    "mcp_jira_jira_transition_issue" = true;
    "mcp_jira_jira_create_sprint" = true;
    "mcp_jira_jira_update_sprint" = true;
    "mcp_jira_jira_add_issues_to_sprint" = true;
    "mcp_jira_jira_get_project_versions" = true;
    "mcp_jira_jira_get_project_components" = true;
    "mcp_jira_jira_get_all_projects" = true;
    "mcp_jira_jira_get_service_desk_for_project" = true;
    "mcp_jira_jira_get_service_desk_queues" = true;
    "mcp_jira_jira_get_queue_issues" = true;
    "mcp_jira_jira_create_version" = true;
    "mcp_jira_jira_batch_create_versions" = true;
    "mcp_jira_jira_get_issue_proforma_forms" = true;
    "mcp_jira_jira_get_proforma_form_details" = true;
    "mcp_jira_jira_update_proforma_form_answers" = true;
    "mcp_jira_jira_get_issue_dates" = true;
    "mcp_jira_jira_get_issue_sla" = true;
    "mcp_jira_jira_get_issue_development_info" = true;
    "mcp_jira_jira_get_issues_development_info" = true;
  };
  confluenceMcp = {
    "mcp_jira_confluence_search" = true;
    "mcp_jira_confluence_get_page" = true;
    "mcp_jira_confluence_get_page_children" = true;
    "mcp_jira_confluence_get_space_page_tree" = true;
    "mcp_jira_confluence_get_comments" = true;
    "mcp_jira_confluence_get_labels" = true;
    "mcp_jira_confluence_add_label" = true;
    "mcp_jira_confluence_create_page" = true;
    "mcp_jira_confluence_update_page" = true;
    "mcp_jira_confluence_delete_page" = true;
    "mcp_jira_confluence_move_page" = true;
    "mcp_jira_confluence_add_comment" = true;
    "mcp_jira_confluence_reply_to_comment" = true;
    "mcp_jira_confluence_search_user" = true;
    "mcp_jira_confluence_get_page_history" = true;
    "mcp_jira_confluence_get_page_diff" = true;
    "mcp_jira_confluence_get_page_views" = true;
    "mcp_jira_confluence_upload_attachment" = true;
    "mcp_jira_confluence_upload_attachments" = true;
    "mcp_jira_confluence_get_attachments" = true;
    "mcp_jira_confluence_download_attachment" = true;
    "mcp_jira_confluence_download_content_attachments" = true;
    "mcp_jira_confluence_delete_attachment" = true;
    "mcp_jira_confluence_get_page_images" = true;
  };
  pdfMcp = {
    "mcp_pdf_read_pdf" = true;
  };

  kagiMcp = {
    #"mcp-kagi_tool-kagi-summarizer-pst" = true;
    "mcp_kagi_kagi_search_fetch" = true;
  };
  wikiMcp = {
    #"mcp_wikipedia_get_coordinates" = true;
    #"mcp_wikipedia_test_wikipedia_connectivity" = true;

    "mcp_wikipedia_search_wikipedia" = true;
    "mcp_wikipedia_get_article" = true;
    "mcp_wikipedia_get_summary" = true;
    "mcp_wikipedia_summarize_article_for_query" = true;
    "mcp_wikipedia_summarize_article_section" = true;
    "mcp_wikipedia_extract_key_facts" = true;
    "mcp_wikipedia_get_related_topics" = true;
    "mcp_wikipedia_get_sections" = true;
    "mcp_wikipedia_get_links" = true;
  };

  browserMcp = {
    "mcp_playwright_browser_close" = true;
    "mcp_playwright_browser_resize" = true;
    "mcp_playwright_browser_console_messages" = true;
    "mcp_playwright_browser_handle_dialog" = true;
    "mcp_playwright_browser_evaluate" = true;
    "mcp_playwright_browser_file_upload" = true;
    "mcp_playwright_browser_install" = true;
    "mcp_playwright_browser_press_key" = true;
    "mcp_playwright_browser_type" = true;
    "mcp_playwright_browser_navigate" = true;
    "mcp_playwright_browser_navigate_back" = true;
    "mcp_playwright_browser_network_requests" = true;
    "mcp_playwright_browser_run_code_unsafe" = true;
    "mcp_playwright_browser_take_screenshot" = true;
    "mcp_playwright_browser_snapshot" = true;
    "mcp_playwright_browser_click" = true;
    "mcp_playwright_browser_drag" = true;
    "mcp_playwright_browser_hover" = true;
    "mcp_playwright_browser_select_option" = true;
    "mcp_playwright_browser_tabs" = true;
    "mcp_playwright_browser_wait_for" = true;
  };

  browserUseMcp = {
    "mcp_browseruse_browser_navigate" = true;
    "mcp_browseruse_browser_click" = true;
    "mcp_browseruse_browser_type" = false;
    "mcp_browseruse_browser_get_state" = true;
    "mcp_browseruse_browser_extract_content" = true;
    "mcp_browseruse_browser_get_html" = true;
    "mcp_browseruse_browser_screenshot" = false;
    "mcp_browseruse_browser_scroll" = true;
    "mcp_browseruse_browser_go_back" = true;
    #"mcp_browseruse_browser_list_tabs" = true;
    #"mcp_browseruse_browser_switch_tab" = true;
    #"mcp_browseruse_browser_close_tab" = true;
    #"mcp_browseruse_browser_retry_with_browser_use_agent" = true;

  };

}
